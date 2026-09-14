import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  createDefaultDiscoAgentProfile,
  type DiscoAgentProfile,
  normalizeDiscoAgentProfile,
  reconcileDiscoAgentProfile,
  renderDiscoAgentProfileFiles,
} from '@disco/core';
import {
  type AgentLearningReviewInput,
  type AgentLearningReviewRequest,
  type AgentLearningReviewResult,
  completeAgentLearningReview,
  getAgentLearningStatus,
  readDiscoAgentMemories,
  recordAgentMemoryChange,
} from '@disco/core/agent-runtime';
import {
  AgentRepository,
  SessionRepository,
  SkillLifecycleRepository,
  TaskRepository,
  type TenantScopeAwareDatabase,
} from '@disco/core/db';
import { BadRequest, NotAuthenticated, NotFound } from '@disco/core/feathers';
import type {
  Agent,
  AgentCapabilityEntry,
  AgentCapabilityKind,
  AgentCapabilityPatch,
  AgentID,
  AgentMemoryUpsertInput,
  AuthenticatedParams,
  DiscoSkillInstallInput,
  UserID,
} from '@disco/core/types';
import {
  adoptExistingAgentSkill,
  installManagedDiscoSkill,
  patchManagedDiscoSkill,
} from './skill-lifecycle.js';

const MAX_EDITABLE_CAPABILITY_BYTES = 512 * 1024;
const SETTINGS_RELATIVE_PATH = '.disco/capabilities.json';
const PROFILE_RELATIVE_PATH = '.disco/agent.json';

const PROFILE_DOCUMENTS = {
  '.disco/IDENTITY.md': 'identity',
  '.disco/RESPONSIBILITIES.md': 'responsibilities',
  '.disco/SOUL.md': 'soul',
  '.disco/USER.md': 'user_preferences',
} as const;

interface CapabilitySettings {
  version: 1;
  enabled: Record<string, boolean>;
}

interface DiscoveredCapability extends AgentCapabilityEntry {
  absolutePath: string;
}

function writeManagedWorkspaceFile(target: string, content: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  const normalized = content.replace(/^\uFEFF/u, '').replace(/\r?\n/gu, '\n');
  const serialized =
    process.platform === 'win32' && target.toLowerCase().endsWith('.md')
      ? `\uFEFF${normalized}`
      : normalized;
  if (existsSync(target) && readFileSync(target, 'utf8') === serialized) return;
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, serialized, 'utf8');
  try {
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
}

function capabilityKey(kind: AgentCapabilityKind, relativePath: string): string {
  return `${kind}:${normalizeRelative(relativePath).toLowerCase()}`;
}

function capabilityId(agentId: string, kind: AgentCapabilityKind, relativePath: string): string {
  return `agentcap_${createHash('sha256')
    .update(`${agentId}:${capabilityKey(kind, relativePath)}`)
    .digest('hex')
    .slice(0, 24)}`;
}

function settingsPath(workspacePath: string): string {
  return path.join(workspacePath, ...SETTINGS_RELATIVE_PATH.split('/'));
}

function profilePath(workspacePath: string): string {
  return path.join(workspacePath, ...PROFILE_RELATIVE_PATH.split('/'));
}

function writeMissingWorkspaceFile(target: string, content: string): void {
  if (existsSync(target)) return;
  writeManagedWorkspaceFile(target, content);
}

function writeAgentProfile(workspacePath: string, profile: DiscoAgentProfile): void {
  const target = profilePath(workspacePath);
  writeManagedWorkspaceFile(target, `${JSON.stringify(profile, null, 2)}\n`);
}

function normalizedMemoryDocument(content: string, now = new Date().toISOString()): string {
  const withoutBom = content.replace(/^\uFEFF/u, '').trim();
  if (/^---\s*\r?\n[\s\S]*?\r?\n---/u.test(withoutBom)) {
    const withUpdatedAt = /^updated_at:\s*.+$/mu.test(withoutBom)
      ? withoutBom.replace(/^updated_at:\s*.+$/mu, `updated_at: ${now}`)
      : withoutBom.replace(/^---\s*$/mu, `---\nupdated_at: ${now}`);
    return `${withUpdatedAt}\n`;
  }
  return `---
version: 1
topic: 通用
source: user-explicit
confidence: 1
status: active
created_at: ${now}
updated_at: ${now}
---
${withoutBom || '# 通用记忆\n\n尚未记录。'}
`;
}

function frontmatterScalar(content: string, key: string): string | undefined {
  const raw = content
    .match(/^---\s*\r?\n([\s\S]*?)\r?\n---/u)?.[1]
    ?.match(new RegExp(`^${key}:\\s*(.+)$`, 'mu'))?.[1]
    ?.trim();
  if (!raw) return undefined;
  if (/^"[\s\S]*"$/u.test(raw)) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === 'string' ? parsed : raw;
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw.replace(/^['"]|['"]$/gu, '');
}

function memoryBody(content: string): string {
  return content
    .replace(/^\uFEFF/u, '')
    .replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*/u, '')
    .replace(/^#\s+.*(?:\r?\n)+/u, '')
    .trim();
}

function safeMemoryBasename(topic: string): string {
  const normalized = topic
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Windows filenames must exclude control characters.
    .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, '-')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^[. -]+|[. -]+$/gu, '')
    .slice(0, 64);
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
  if (normalized && !reserved.test(normalized)) return normalized;
  return `memory-${createHash('sha256').update(topic).digest('hex').slice(0, 12)}`;
}

function renderStructuredMemory(options: {
  topic: string;
  body: string;
  source: 'user-explicit' | 'agent-inference';
  confidence: number;
  createdAt: string;
  updatedAt: string;
  status?: string;
  provenance?: string;
}): string {
  return `---
version: 1
topic: ${JSON.stringify(options.topic)}
source: ${options.source}
confidence: ${options.confidence}
status: ${options.status ?? 'active'}
created_at: ${options.createdAt}
updated_at: ${options.updatedAt}
provenance: ${options.provenance ?? '[]'}
---
# ${options.topic}

${options.body.trim()}
`;
}

function upsertAgentMemory(agent: Agent, input: AgentMemoryUpsertInput): AgentCapabilityEntry {
  const workspacePath = agent.workspace_path;
  const topic = input.topic.trim();
  const incomingBody = input.content.trim();
  if (!topic) throw new BadRequest('topic is required');
  if (!incomingBody) throw new BadRequest('content is required');
  if (Buffer.byteLength(incomingBody, 'utf8') > MAX_EDITABLE_CAPABILITY_BYTES) {
    throw new BadRequest('Memory content is too large');
  }
  const source = input.source ?? 'user-explicit';
  const confidence = input.confidence ?? (source === 'user-explicit' ? 1 : 0.75);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new BadRequest('confidence must be between 0 and 1');
  }

  const memoryRoot = path.join(workspacePath, '.disco', 'memory');
  mkdirSync(memoryRoot, { recursive: true });
  const existingPath = safeMarkdownFiles(memoryRoot, 2).find((candidate) => {
    const existing = readFileSync(candidate, 'utf8').replace(/^\uFEFF/u, '');
    return (
      frontmatterScalar(existing, 'topic')?.localeCompare(topic, undefined, {
        sensitivity: 'accent',
      }) === 0
    );
  });
  let target = existingPath ?? path.join(memoryRoot, `${safeMemoryBasename(topic)}.md`);
  if (!existingPath && existsSync(target)) {
    target = path.join(
      memoryRoot,
      `${safeMemoryBasename(topic)}-${createHash('sha256').update(topic).digest('hex').slice(0, 8)}.md`
    );
  }

  const existingContent = existsSync(target)
    ? readFileSync(target, 'utf8').replace(/^\uFEFF/u, '')
    : '';
  const previousBody = memoryBody(existingContent);
  if (
    input.expected_updated_at !== undefined &&
    input.expected_updated_at !== frontmatterScalar(existingContent, 'updated_at')
  ) {
    throw new BadRequest('Memory changed since it was inspected; read it again before replacing');
  }
  const operation = input.operation ?? 'append';
  const nextBody =
    operation === 'replace'
      ? incomingBody
      : !previousBody
        ? incomingBody
        : previousBody.includes(incomingBody)
          ? previousBody
          : `${previousBody}\n\n${incomingBody}`;
  const previousUpdatedAt = Date.parse(frontmatterScalar(existingContent, 'updated_at') ?? '');
  const now = new Date(
    Math.max(Date.now(), Number.isFinite(previousUpdatedAt) ? previousUpdatedAt + 1 : 0)
  ).toISOString();
  const createdAt = frontmatterScalar(existingContent, 'created_at') ?? now;
  const changed =
    previousBody !== nextBody ||
    frontmatterScalar(existingContent, 'source') !== source ||
    Number(frontmatterScalar(existingContent, 'confidence')) !== confidence;
  let provenance: unknown[] = [];
  try {
    const parsed = JSON.parse(frontmatterScalar(existingContent, 'provenance') ?? '[]') as unknown;
    if (Array.isArray(parsed)) provenance = parsed;
  } catch {
    /* Legacy documents have no provenance array. */
  }
  if (changed) {
    provenance.push({
      source,
      confidence,
      session_id: input.source_session_id ?? null,
      operation,
      recorded_at: now,
      content_hash: createHash('sha256').update(incomingBody).digest('hex'),
    });
  }
  const nextContent = renderStructuredMemory({
    topic,
    body: nextBody,
    source,
    confidence,
    createdAt,
    status: frontmatterScalar(existingContent, 'status') ?? 'active',
    provenance: JSON.stringify(provenance),
    updatedAt:
      existingContent && !changed ? (frontmatterScalar(existingContent, 'updated_at') ?? now) : now,
  });
  writeManagedWorkspaceFile(target, nextContent);

  const relativePath = normalizeRelative(path.relative(workspacePath, target));
  const settings = readAgentCapabilitySettings(workspacePath);
  settings.enabled[capabilityKey('memory', relativePath)] ??= true;
  writeAgentCapabilitySettings(workspacePath, settings);
  renderMemoryIndex(workspacePath);
  recordAgentMemoryChange(workspacePath, readDiscoAgentMemories(workspacePath));
  const entry = discoverAgentCapabilityFiles(agent.agent_id, workspacePath).find(
    (candidate) => candidate.kind === 'memory' && candidate.relative_path === relativePath
  );
  if (!entry) throw new NotFound('Memory was saved but could not be rediscovered');
  return publicCapability(entry);
}

function renderMemoryIndex(workspacePath: string): void {
  const memoryRoot = path.join(workspacePath, '.disco', 'memory');
  const settings = readAgentCapabilitySettings(workspacePath);
  const lines = safeMarkdownFiles(memoryRoot, 2)
    .map((absolutePath) => {
      const relativePath = normalizeRelative(path.relative(workspacePath, absolutePath));
      if (settings.enabled[capabilityKey('memory', relativePath)] === false) return null;
      const content = readFileSync(absolutePath, 'utf8').replace(/^\uFEFF/u, '');
      if ((content.match(/^status:\s*(.+)$/mu)?.[1]?.trim() || 'active') !== 'active') return null;
      const heading =
        content.match(/^#\s+(.+)$/mu)?.[1]?.trim() || path.basename(absolutePath, '.md');
      const indexTarget = normalizeRelative(
        path.relative(path.join(workspacePath, '.disco'), absolutePath)
      );
      return `- [${heading}](${indexTarget})`;
    })
    .filter((line): line is string => Boolean(line));
  writeManagedWorkspaceFile(
    path.join(workspacePath, '.disco', 'MEMORY.md'),
    `# 长期记忆索引\n\n${lines.length > 0 ? lines.join('\n') : '尚未记录。'}\n`
  );
}

export interface AgentProfileScaffoldInput {
  workspacePath: string;
  displayName: string;
  responsibilities?: string | null;
}

export function ensureAgentProfileScaffoldForWorkspace(
  input: AgentProfileScaffoldInput
): DiscoAgentProfile {
  const workspacePath = input.workspacePath;
  const discoDirectory = path.join(workspacePath, '.disco');
  const displayName = input.displayName.trim() || '智能体';
  const responsibilities = input.responsibilities?.trim() || '根据用户后续指示维护自己的长期职责。';

  mkdirSync(path.join(discoDirectory, 'memory'), { recursive: true });
  mkdirSync(path.join(workspacePath, 'skills'), { recursive: true });
  let profile: DiscoAgentProfile;
  try {
    profile = normalizeDiscoAgentProfile(
      JSON.parse(readFileSync(profilePath(workspacePath), 'utf8')),
      { displayName, responsibilities }
    );
  } catch {
    profile = createDefaultDiscoAgentProfile({ displayName, responsibilities });
  }
  profile = reconcileDiscoAgentProfile(profile, { displayName, responsibilities });
  writeAgentProfile(workspacePath, profile);
  for (const [relativePath, content] of Object.entries(renderDiscoAgentProfileFiles(profile))) {
    const target = path.join(workspacePath, ...relativePath.split('/'));
    writeManagedWorkspaceFile(target, content);
  }
  writeMissingWorkspaceFile(
    settingsPath(workspacePath),
    '{\n  "version": 1,\n  "enabled": {}\n}\n'
  );
  renderMemoryIndex(workspacePath);
  return profile;
}

export function readAgentCapabilitySettings(workspacePath: string): CapabilitySettings {
  try {
    // Agent-authored files may be written by Windows PowerShell, which can
    // prepend a UTF-8 BOM. Treat that as an encoding detail instead of
    // silently falling back to an empty settings object and dropping every
    // unrelated memory/skill override on the next patch.
    const raw = JSON.parse(
      readFileSync(settingsPath(workspacePath), 'utf8').replace(/^\uFEFF/u, '')
    ) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid settings');
    const enabled = (raw as { enabled?: unknown }).enabled;
    return {
      version: 1,
      enabled:
        enabled && typeof enabled === 'object' && !Array.isArray(enabled)
          ? Object.fromEntries(
              Object.entries(enabled).filter(
                (entry): entry is [string, boolean] => typeof entry[1] === 'boolean'
              )
            )
          : {},
    };
  } catch {
    return { version: 1, enabled: {} };
  }
}

function writeAgentCapabilitySettings(workspacePath: string, settings: CapabilitySettings): void {
  const target = settingsPath(workspacePath);
  writeManagedWorkspaceFile(target, `${JSON.stringify(settings, null, 2)}\n`);
}

export function isAgentCapabilityEnabled(
  workspacePath: string,
  kind: AgentCapabilityKind,
  relativePath: string
): boolean {
  return (
    readAgentCapabilitySettings(workspacePath).enabled[capabilityKey(kind, relativePath)] !== false
  );
}

function markdownMetadata(content: string, fallbackName: string) {
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/u)?.[1] ?? '';
  const scalar = (key: string) =>
    frontmatter
      .match(new RegExp(`^${key}:\\s*(.+)$`, 'mu'))?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/gu, '');
  const heading = content.match(/^#\s+(.+)$/mu)?.[1]?.trim();
  const description =
    scalar('description') ||
    content
      .replace(/^---[\s\S]*?---\s*/u, '')
      .replace(/<!--[\s\S]*?-->/gu, '')
      .replace(/^#.*$/gmu, '')
      .split(/\r?\n\s*\r?\n/u)
      .map((part) => part.replace(/\s+/gu, ' ').trim())
      .find(Boolean) ||
    '暂无说明。';
  return {
    name: scalar('name') || heading || fallbackName,
    description: description.slice(0, 600),
  };
}

function safeMarkdownFiles(directory: string, maxDepth: number): string[] {
  const result: string[] = [];
  const visit = (current: string, depth: number) => {
    if (depth > maxDepth || !existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) visit(candidate, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) result.push(candidate);
    }
  };
  visit(directory, 0);
  return result;
}

export function discoverAgentCapabilityFiles(
  agentId: AgentID,
  workspacePath: string
): DiscoveredCapability[] {
  const root = path.resolve(workspacePath);
  const settings = readAgentCapabilitySettings(root);
  const candidates: Array<{
    kind: AgentCapabilityKind;
    absolutePath: string;
    removable: boolean;
  }> = [];

  for (const profileName of ['IDENTITY.md', 'RESPONSIBILITIES.md', 'SOUL.md', 'USER.md'] as const) {
    const profilePath = path.join(root, '.disco', profileName);
    if (existsSync(profilePath)) {
      candidates.push({ kind: 'profile', absolutePath: profilePath, removable: false });
    }
  }

  for (const skillDirectory of existsSync(path.join(root, 'skills'))
    ? readdirSync(path.join(root, 'skills'), { withFileTypes: true })
    : []) {
    if (!skillDirectory.isDirectory()) continue;
    const skillPath = path.join(root, 'skills', skillDirectory.name, 'SKILL.md');
    if (existsSync(skillPath))
      candidates.push({ kind: 'skill', absolutePath: skillPath, removable: true });
  }

  for (const memoryPath of safeMarkdownFiles(path.join(root, '.disco', 'memory'), 2)) {
    candidates.push({ kind: 'memory', absolutePath: memoryPath, removable: true });
  }

  return candidates
    .map(({ kind, absolutePath, removable }): DiscoveredCapability | null => {
      const resolved = path.resolve(absolutePath);
      const relativePath = normalizeRelative(path.relative(root, resolved));
      if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath))
        return null;
      const content = readFileSync(resolved, 'utf8').replace(/^\uFEFF/u, '');
      const metadata = markdownMetadata(content, path.basename(path.dirname(resolved)));
      const stats = statSync(resolved);
      return {
        id: capabilityId(agentId, kind, relativePath),
        agent_id: agentId,
        kind,
        name: metadata.name,
        description: metadata.description,
        relative_path: relativePath,
        content,
        enabled: settings.enabled[capabilityKey(kind, relativePath)] !== false,
        editable: true,
        removable,
        updated_at:
          (kind === 'memory' ? frontmatterScalar(content, 'updated_at') : undefined) ??
          stats.mtime.toISOString(),
        absolutePath: resolved,
      };
    })
    .filter((entry): entry is DiscoveredCapability => entry !== null)
    .sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name, 'zh-CN')
    );
}

async function authorizedAgent(
  db: TenantScopeAwareDatabase,
  params: AuthenticatedParams | undefined
): Promise<Agent> {
  const user = params?.user;
  if (!user?.user_id) throw new NotAuthenticated('Authentication required');
  const agentId = params?.query?.agent_id;
  if (typeof agentId !== 'string' || !agentId) {
    throw new BadRequest('agent_id query is required');
  }
  const agent = await new AgentRepository(db).findOwnedById(agentId, user.user_id);
  if (agent?.state !== 'ready' || agent.archived) throw new NotFound('Agent workspace not found');
  // Agent memory and self-authored capabilities are personal data. Admin roles
  // manage accounts, not another user's private agent mind, so there is no
  // elevated-role bypass here.
  ensureAgentProfileScaffoldForWorkspace({
    workspacePath: agent.workspace_path,
    displayName: agent.display_name,
    responsibilities: agent.description,
  });
  return agent;
}

function publicCapability(entry: DiscoveredCapability): AgentCapabilityEntry {
  const { absolutePath: _absolutePath, ...result } = entry;
  return result;
}

async function capabilitiesWithLifecycle(
  db: TenantScopeAwareDatabase,
  agent: Agent
): Promise<AgentCapabilityEntry[]> {
  const discovered = discoverAgentCapabilityFiles(agent.agent_id, agent.workspace_path);
  const records = (await new SkillLifecycleRepository(db).findRecords()).filter(
    (record) =>
      record.scope === 'agent' &&
      record.agent_id === agent.agent_id &&
      record.status !== 'uninstalled'
  );
  const byRelativePath = new Map(
    records.map((record) => [normalizeRelative(record.relative_path).toLowerCase(), record])
  );
  for (const entry of discovered) {
    const relativePath = normalizeRelative(entry.relative_path).toLowerCase();
    if (entry.kind !== 'skill' || byRelativePath.has(relativePath)) continue;
    const adopted = await adoptExistingAgentSkill({
      db,
      actorUserId: agent.created_by,
      agent,
      relativePath: entry.relative_path,
      name: entry.name,
      description: entry.description,
      enabled: entry.enabled,
    });
    byRelativePath.set(relativePath, adopted);
  }
  return discovered.map((entry) => {
    const lifecycle =
      entry.kind === 'skill'
        ? byRelativePath.get(normalizeRelative(entry.relative_path).toLowerCase())
        : undefined;
    return {
      ...publicCapability(entry),
      enabled: lifecycle ? lifecycle.status === 'enabled' : entry.enabled,
      lifecycle,
    };
  });
}

function updateProfileDocument(workspacePath: string, relativePath: string, content: string): void {
  const documentKey =
    PROFILE_DOCUMENTS[normalizeRelative(relativePath) as keyof typeof PROFILE_DOCUMENTS];
  if (!documentKey) throw new BadRequest('This generated profile document is not editable');
  let profile: DiscoAgentProfile;
  try {
    profile = JSON.parse(readFileSync(profilePath(workspacePath), 'utf8')) as DiscoAgentProfile;
  } catch {
    throw new BadRequest('The canonical agent profile is unavailable');
  }
  profile.documents[documentKey] = `${content.trim()}\n`;
  profile.updated_at = new Date().toISOString();
  writeAgentProfile(workspacePath, profile);
  for (const [generatedPath, generatedContent] of Object.entries(
    renderDiscoAgentProfileFiles(profile)
  )) {
    writeManagedWorkspaceFile(
      path.join(workspacePath, ...generatedPath.split('/')),
      generatedContent
    );
  }
}

export class AgentCapabilitiesService {
  constructor(private db: TenantScopeAwareDatabase) {}

  /** Called inside create's standard authentication and tenant database hooks. */
  private async reviewLearning(
    input: AgentLearningReviewInput,
    sessionId: string,
    params?: AuthenticatedParams
  ): Promise<AgentLearningReviewResult> {
    const agent = await authorizedAgent(this.db, params);
    const [task, session] = await Promise.all([
      new TaskRepository(this.db).findById(input.taskId),
      new SessionRepository(this.db).findById(sessionId),
    ]);
    if (
      !session ||
      session.agent_id !== agent.agent_id ||
      session.created_by !== agent.created_by ||
      !task ||
      task.task_id !== input.taskId ||
      task.session_id !== sessionId ||
      task.created_by !== agent.created_by ||
      task.status !== 'running'
    ) {
      throw new BadRequest(
        'Learning review requires the current running task of this agent session'
      );
    }
    const memories = readDiscoAgentMemories(agent.workspace_path);
    if (input.phase === 'inspect') {
      return { ...getAgentLearningStatus(agent.workspace_path, memories), memories };
    }
    const result = completeAgentLearningReview({
      workspace: agent.workspace_path,
      memories,
      sessionId,
      input,
    });
    return { ...result, reviewed: true };
  }

  async find(params?: AuthenticatedParams): Promise<AgentCapabilityEntry[]> {
    const agent = await authorizedAgent(this.db, params);
    return capabilitiesWithLifecycle(this.db, agent);
  }

  async get(id: string, params?: AuthenticatedParams): Promise<AgentCapabilityEntry> {
    const agent = await authorizedAgent(this.db, params);
    const entry = (await capabilitiesWithLifecycle(this.db, agent)).find(
      (candidate) => candidate.id === id
    );
    if (!entry) throw new NotFound(`Agent capability not found: ${id}`);
    return entry;
  }

  async create(
    data: DiscoSkillInstallInput | AgentMemoryUpsertInput,
    params?: AuthenticatedParams
  ): Promise<AgentCapabilityEntry>;
  async create(
    data: AgentLearningReviewRequest,
    params?: AuthenticatedParams
  ): Promise<AgentLearningReviewResult>;
  async create(
    data: DiscoSkillInstallInput | AgentMemoryUpsertInput | AgentLearningReviewRequest,
    params?: AuthenticatedParams
  ): Promise<AgentCapabilityEntry | AgentLearningReviewResult> {
    if ('kind' in data && data.kind === 'learning-review') {
      return this.reviewLearning(data, data.source_session_id, params);
    }
    const agent = await authorizedAgent(this.db, params);
    const actorUserId = params?.user?.user_id as UserID | undefined;
    if (!actorUserId) throw new NotAuthenticated('Authentication required');
    if ('kind' in data && data.kind === 'memory') {
      return upsertAgentMemory(agent, data);
    }
    const skillData = data as DiscoSkillInstallInput;
    const record = await installManagedDiscoSkill({
      db: this.db,
      actorUserId,
      input: {
        ...skillData,
        scope: 'agent',
        agent_id: agent.agent_id,
      },
      defaultScope: 'agent',
      defaultAgentId: agent.agent_id,
      sourceSessionId: skillData.source_session_id ?? null,
    });
    const entry = (await capabilitiesWithLifecycle(this.db, agent)).find(
      (candidate) => candidate.lifecycle?.id === record.id
    );
    if (!entry) throw new NotFound(`Installed agent skill not found: ${record.id}`);
    return entry;
  }

  async patch(
    id: string,
    data: AgentCapabilityPatch,
    params?: AuthenticatedParams
  ): Promise<AgentCapabilityEntry> {
    const agent = await authorizedAgent(this.db, params);
    const entry = discoverAgentCapabilityFiles(agent.agent_id, agent.workspace_path).find(
      (candidate) => candidate.id === id
    );
    const entryView = (await capabilitiesWithLifecycle(this.db, agent)).find(
      (candidate) => candidate.id === id
    );
    if (!entry || !entryView) throw new NotFound(`Agent capability not found: ${id}`);
    if (data.content === undefined && data.enabled === undefined && data.action === undefined) {
      throw new BadRequest('content, enabled or action is required');
    }
    const actorUserId = params?.user?.user_id as UserID | undefined;
    if (!actorUserId) throw new NotAuthenticated('Authentication required');
    if (entry.kind === 'skill' && entryView.lifecycle) {
      const updatedLifecycle = await patchManagedDiscoSkill({
        db: this.db,
        actorUserId,
        skillId: entryView.lifecycle.id,
        patch: {
          enabled: data.enabled,
          skill_markdown: data.content,
          action: data.action,
          confirmation: data.confirmation,
        },
      });
      if (updatedLifecycle.status === 'uninstalled') {
        return { ...entryView, enabled: false, lifecycle: updatedLifecycle };
      }
      const updated = (await capabilitiesWithLifecycle(this.db, agent)).find(
        (candidate) => candidate.lifecycle?.id === updatedLifecycle.id
      );
      if (!updated) throw new NotFound(`Agent skill not found after update: ${id}`);
      return updated;
    }
    if (data.content !== undefined) {
      if (typeof data.content !== 'string') throw new BadRequest('content must be a string');
      if (Buffer.byteLength(data.content, 'utf8') > MAX_EDITABLE_CAPABILITY_BYTES) {
        throw new BadRequest('Capability content is too large to edit in the browser');
      }
      if (entry.kind === 'profile') {
        updateProfileDocument(agent.workspace_path, entry.relative_path, data.content);
      } else if (entry.kind === 'memory') {
        writeManagedWorkspaceFile(entry.absolutePath, normalizedMemoryDocument(data.content));
      } else {
        writeManagedWorkspaceFile(entry.absolutePath, data.content);
      }
    }
    if (data.enabled !== undefined) {
      if (typeof data.enabled !== 'boolean') throw new BadRequest('enabled must be a boolean');
      const settings = readAgentCapabilitySettings(agent.workspace_path);
      settings.enabled[capabilityKey(entry.kind, entry.relative_path)] = data.enabled;
      writeAgentCapabilitySettings(agent.workspace_path, settings);
    }
    if (entry.kind === 'memory') {
      renderMemoryIndex(agent.workspace_path);
      recordAgentMemoryChange(agent.workspace_path, readDiscoAgentMemories(agent.workspace_path));
    }
    const updated = (await capabilitiesWithLifecycle(this.db, agent)).find(
      (candidate) => candidate.id === id
    );
    if (!updated) throw new NotFound(`Agent capability not found after update: ${id}`);
    return updated;
  }

  async remove(id: string, params?: AuthenticatedParams): Promise<AgentCapabilityEntry> {
    const agent = await authorizedAgent(this.db, params);
    const entry = discoverAgentCapabilityFiles(agent.agent_id, agent.workspace_path).find(
      (candidate) => candidate.id === id
    );
    if (!entry) throw new NotFound(`Agent capability not found: ${id}`);
    if (!entry.removable) throw new BadRequest('The primary long-term memory cannot be deleted');
    if (entry.kind === 'skill') {
      throw new BadRequest('Use the confirmed uninstall action to remove a skill');
    }
    rmSync(entry.absolutePath);
    if (entry.kind === 'memory') {
      renderMemoryIndex(agent.workspace_path);
      recordAgentMemoryChange(agent.workspace_path, readDiscoAgentMemories(agent.workspace_path));
    }
    return publicCapability(entry);
  }
}

export function createAgentCapabilitiesService(db: TenantScopeAwareDatabase) {
  return new AgentCapabilitiesService(db);
}
