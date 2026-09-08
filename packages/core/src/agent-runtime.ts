import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { type DiscoAgentProfile, normalizeDiscoAgentProfile } from './agent-profile.js';

const RUNTIME_DIRECTORY = '.disco-runtime';
const RUNTIME_CONTEXT_FILE = 'agent-context.md';
const PRELOAD_STATUS_FILE = 'preload.json';

interface CapabilitySettings {
  enabled: Record<string, boolean>;
}

export interface DiscoAgentRuntimeSnapshot {
  version: 1;
  status: 'ready';
  fingerprint: string;
  source_fingerprint: string;
  prepared_at: string;
  agent_workspace: string;
  session_workspace: string;
  profile_updated_at: string;
  memory_files: number;
  skill_files: number;
  context_file: string;
  content: string;
}

export interface DiscoAgentRuntimePreloadFailure {
  version: 1;
  status: 'failed';
  attempted_at: string;
  message: string;
}

function writeAtomic(target: string, content: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, content, 'utf8');
  try {
    // Windows cannot reliably rename over an existing destination. Runtime
    // snapshots are refreshed before every prompt, so remove only the exact
    // managed file before replacing it.
    rmSync(target, { force: true });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
}

function readCapabilitySettings(agentWorkspace: string): CapabilitySettings {
  try {
    const value = JSON.parse(
      readFileSync(path.join(agentWorkspace, '.disco', 'capabilities.json'), 'utf8').replace(
        /^\uFEFF/u,
        ''
      )
    ) as { enabled?: unknown };
    return {
      enabled:
        value.enabled && typeof value.enabled === 'object' && !Array.isArray(value.enabled)
          ? Object.fromEntries(
              Object.entries(value.enabled).filter(
                (entry): entry is [string, boolean] => typeof entry[1] === 'boolean'
              )
            )
          : {},
    };
  } catch {
    return { enabled: {} };
  }
}

function capabilityEnabled(
  settings: CapabilitySettings,
  kind: 'profile' | 'memory' | 'skill',
  relativePath: string
): boolean {
  return settings.enabled[`${kind}:${normalizeRelative(relativePath).toLowerCase()}`] !== false;
}

function markdownFiles(root: string, maxDepth: number): string[] {
  const files: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > maxDepth || !existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(candidate);
    }
  };
  visit(root, 0);
  return files.sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function sourceContentFingerprint(agentWorkspace: string, files: string[]): string {
  const hash = createHash('sha256');
  for (const absolutePath of [...new Set(files.map((file) => path.resolve(file)))].sort(
    (left, right) => left.localeCompare(right, 'en')
  )) {
    if (!existsSync(absolutePath)) continue;
    hash.update(normalizeRelative(path.relative(agentWorkspace, absolutePath)));
    hash.update('\0');
    hash.update(readFileSync(absolutePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function withoutBom(value: string): string {
  return value.replace(/^\uFEFF/u, '').trim();
}

function withoutFrontmatter(value: string): string {
  return withoutBom(value).replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*/u, '');
}

function readableDocumentBody(value: string): string {
  let body = withoutFrontmatter(value)
    .replace(/<!--\s*disco:[\s\S]*?-->/gu, '')
    .trim();
  while (/^#{1,2}\s+[^\r\n]+(?:\r?\n)+/u.test(body)) {
    body = body.replace(/^#{1,2}\s+[^\r\n]+(?:\r?\n)+/u, '').trim();
  }
  return body;
}

function activeMemoryDocument(value: string): boolean {
  if ((value.match(/^status:\s*(.+)$/mu)?.[1]?.trim() || 'active') !== 'active') return false;
  const body = withoutBom(value)
    .replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*/u, '')
    .replace(/^#+\s+.*$/gmu, '')
    .trim();
  return Boolean(body && body !== '尚未记录。');
}

function readCanonicalProfile(agentWorkspace: string): DiscoAgentProfile {
  const profilePath = path.join(agentWorkspace, '.disco', 'agent.json');
  if (!existsSync(profilePath)) {
    throw new Error(`Agent canonical profile is missing: ${profilePath}`);
  }
  const raw = JSON.parse(readFileSync(profilePath, 'utf8')) as unknown;
  const seed =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { display_name?: unknown; responsibilities_summary?: unknown })
      : {};
  return normalizeDiscoAgentProfile(raw, {
    displayName:
      typeof seed.display_name === 'string' && seed.display_name.trim()
        ? seed.display_name
        : '智能体',
    responsibilities:
      typeof seed.responsibilities_summary === 'string' ? seed.responsibilities_summary : undefined,
  });
}

function section(title: string, content: string): string {
  return `## ${title}\n\n${readableDocumentBody(content) || '尚未记录。'}`;
}

function memoryTitle(relativePath: string, content: string): string {
  const normalized = withoutBom(content);
  const frontmatter = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/u)?.[1] ?? '';
  const topic = frontmatter.match(/^topic:\s*(.+)$/mu)?.[1];
  if (topic) return frontmatterScalar(topic);
  const heading = withoutFrontmatter(normalized).match(/^#\s+(.+)$/mu)?.[1]?.trim();
  return heading || path.basename(relativePath, path.extname(relativePath));
}

function frontmatterScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function summarizeSkill(
  relativePath: string,
  content: string
): {
  relativePath: string;
  name: string;
  description: string;
} {
  const normalized = withoutBom(content);
  const frontmatter = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/u)?.[1] ?? '';
  const frontmatterName = frontmatter.match(/^name:\s*(.+)$/mu)?.[1];
  const frontmatterDescription = frontmatter.match(/^description:\s*(.+)$/mu)?.[1];
  const body = normalized.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*/u, '');
  const heading = body.match(/^#\s+(.+)$/mu)?.[1]?.trim();
  const firstParagraph = body
    .split(/\r?\n\s*\r?\n/u)
    .map((paragraph) =>
      paragraph
        .replace(/^#+\s+/u, '')
        .replace(/\s+/gu, ' ')
        .trim()
    )
    .find((paragraph) => Boolean(paragraph));
  return {
    relativePath,
    name:
      (frontmatterName ? frontmatterScalar(frontmatterName) : heading) ||
      path.basename(path.dirname(relativePath)),
    description:
      (frontmatterDescription
        ? frontmatterScalar(frontmatterDescription).replace(/\s+/gu, ' ')
        : firstParagraph) || '暂无简介。',
  };
}

function renderRuntimeContext(options: {
  profileDocuments: Array<{ title: string; content: string }>;
  memories: Array<{ relativePath: string; content: string }>;
  skills: Array<{ relativePath: string; name: string; description: string }>;
}): string {
  const { profileDocuments, memories, skills } = options;
  const memoryContent =
    memories.length > 0
      ? memories
          .map(
            (entry) =>
              `### ${memoryTitle(entry.relativePath, entry.content)}\n\n${readableDocumentBody(entry.content)}`
          )
          .join('\n\n')
      : '尚未记录。';
  const skillContent =
    skills.length > 0
      ? skills
          .map(
            (entry) =>
              `- **${entry.name}**：${entry.description.slice(0, 300)}`
          )
          .join('\n\n')
      : '当前没有已启用技能。';

  return `# 当前智能体资料

以下为当前有效资料。回答身份问题时以此为准。

${profileDocuments.map((document) => section(document.title, document.content)).join('\n\n') || '当前智能体的人格资料均已停用。'}

## 已启用长期记忆

${memoryContent}

## 已启用技能

${skillContent}

完整技能说明在任务相关时按需加载。
`;
}

function runtimePaths(sessionWorkspace: string): { context: string; status: string } {
  const root = path.join(sessionWorkspace, RUNTIME_DIRECTORY);
  return {
    context: path.join(root, RUNTIME_CONTEXT_FILE),
    status: path.join(root, PRELOAD_STATUS_FILE),
  };
}

function readReusableSnapshot(options: {
  paths: { context: string; status: string };
  sourceFingerprint: string;
  agentWorkspace: string;
  sessionWorkspace: string;
}): DiscoAgentRuntimeSnapshot | null {
  if (!existsSync(options.paths.context) || !existsSync(options.paths.status)) return null;

  try {
    const cached = JSON.parse(readFileSync(options.paths.status, 'utf8')) as Partial<
      Omit<DiscoAgentRuntimeSnapshot, 'content'>
    >;
    if (
      cached.version !== 1 ||
      cached.status !== 'ready' ||
      cached.source_fingerprint !== options.sourceFingerprint ||
      typeof cached.fingerprint !== 'string' ||
      cached.agent_workspace !== options.agentWorkspace ||
      cached.session_workspace !== options.sessionWorkspace ||
      cached.context_file !== options.paths.context ||
      typeof cached.profile_updated_at !== 'string' ||
      typeof cached.memory_files !== 'number' ||
      typeof cached.skill_files !== 'number' ||
      typeof cached.prepared_at !== 'string'
    ) {
      return null;
    }

    const cachedContent = readFileSync(options.paths.context, 'utf8');
    if (createHash('sha256').update(cachedContent).digest('hex') !== cached.fingerprint)
      return null;

    return {
      version: 1,
      status: 'ready',
      fingerprint: cached.fingerprint,
      source_fingerprint: options.sourceFingerprint,
      prepared_at: cached.prepared_at,
      agent_workspace: options.agentWorkspace,
      session_workspace: options.sessionWorkspace,
      profile_updated_at: cached.profile_updated_at,
      memory_files: cached.memory_files,
      skill_files: cached.skill_files,
      context_file: options.paths.context,
      content: cachedContent,
    };
  } catch {
    return null;
  }
}

export function prepareDiscoAgentRuntimeContext(options: {
  agentWorkspace: string;
  sessionWorkspace: string;
  now?: string;
}): DiscoAgentRuntimeSnapshot {
  const agentWorkspace = path.resolve(options.agentWorkspace);
  const sessionWorkspace = path.resolve(options.sessionWorkspace);
  const profilePath = path.join(agentWorkspace, '.disco', 'agent.json');
  const capabilitySettingsPath = path.join(agentWorkspace, '.disco', 'capabilities.json');
  const memoryPaths = markdownFiles(path.join(agentWorkspace, '.disco', 'memory'), 2);
  const skillPaths = markdownFiles(path.join(agentWorkspace, 'skills'), 2).filter(
    (absolutePath) => path.basename(absolutePath).toLowerCase() === 'skill.md'
  );
  const sourceFingerprint = sourceContentFingerprint(agentWorkspace, [
    profilePath,
    capabilitySettingsPath,
    ...memoryPaths,
    ...skillPaths,
  ]);
  const paths = runtimePaths(sessionWorkspace);
  const reusable = readReusableSnapshot({
    paths,
    sourceFingerprint,
    agentWorkspace,
    sessionWorkspace,
  });
  if (reusable) return reusable;

  const profile = readCanonicalProfile(agentWorkspace);
  const settings = readCapabilitySettings(agentWorkspace);
  const profileDocuments = [
    {
      title: '身份',
      relativePath: '.disco/IDENTITY.md',
      content: profile.documents.identity,
    },
    {
      title: '长期职责',
      relativePath: '.disco/RESPONSIBILITIES.md',
      content: profile.documents.responsibilities,
    },
    {
      title: '性格与原则',
      relativePath: '.disco/SOUL.md',
      content: profile.documents.soul,
    },
    {
      title: '用户偏好',
      relativePath: '.disco/USER.md',
      content: profile.documents.user_preferences,
    },
  ].filter((document) => capabilityEnabled(settings, 'profile', document.relativePath));
  const memories = memoryPaths
    .map((absolutePath) => {
      const content = readFileSync(absolutePath, 'utf8');
      const relativePath = normalizeRelative(path.relative(agentWorkspace, absolutePath));
      return capabilityEnabled(settings, 'memory', relativePath) && activeMemoryDocument(content)
        ? { relativePath, content }
        : null;
    })
    .filter((entry): entry is { relativePath: string; content: string } => entry !== null);
  const skills = skillPaths
    .map((absolutePath) => {
      const relativePath = normalizeRelative(path.relative(agentWorkspace, absolutePath));
      return capabilityEnabled(settings, 'skill', relativePath)
        ? summarizeSkill(relativePath, readFileSync(absolutePath, 'utf8'))
        : null;
    })
    .filter(
      (entry): entry is { relativePath: string; name: string; description: string } =>
        entry !== null
    );
  const content = renderRuntimeContext({
    profileDocuments,
    memories,
    skills,
  });
  const fingerprint = createHash('sha256').update(content).digest('hex');
  const preparedAt = options.now ?? new Date().toISOString();
  const snapshot: DiscoAgentRuntimeSnapshot = {
    version: 1,
    status: 'ready',
    fingerprint,
    source_fingerprint: sourceFingerprint,
    prepared_at: preparedAt,
    agent_workspace: agentWorkspace,
    session_workspace: sessionWorkspace,
    profile_updated_at: profile.updated_at,
    memory_files: memories.length,
    skill_files: skills.length,
    context_file: paths.context,
    content,
  };
  writeAtomic(paths.context, content);
  writeAtomic(paths.status, `${JSON.stringify({ ...snapshot, content: undefined }, null, 2)}\n`);
  return snapshot;
}

export function writeDiscoAgentPreloadFailure(
  sessionWorkspace: string,
  error: unknown,
  now = new Date().toISOString()
): DiscoAgentRuntimePreloadFailure {
  const failure: DiscoAgentRuntimePreloadFailure = {
    version: 1,
    status: 'failed',
    attempted_at: now,
    message: error instanceof Error ? error.message : String(error),
  };
  writeAtomic(
    runtimePaths(path.resolve(sessionWorkspace)).status,
    `${JSON.stringify(failure, null, 2)}\n`
  );
  return failure;
}
