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
import os from 'node:os';
import path from 'node:path';
import {
  AgentRepository,
  SkillLifecycleRepository,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@disco/core/db';
import { BadRequest, NotFound } from '@disco/core/feathers';
import type {
  Agent,
  DiscoSkillAuditAction,
  DiscoSkillInstallInput,
  DiscoSkillLifecyclePatch,
  DiscoSkillLifecycleRecord,
  DiscoSkillOrigin,
  DiscoSkillScope,
  SessionID,
  UserID,
} from '@disco/core/types';
import { clearSkillCatalogCache } from './skill-catalog-cache.js';

type SkillLifecycleDatabase = TenantScopeAwareDatabase | TenantScopedDatabase;

const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_FILES = 64;

function normalizeRelative(value: string): string {
  return value.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
}

function stableSkillId(input: {
  scope: DiscoSkillScope;
  ownerUserId: string;
  agentId?: string | null;
  slug: string;
}): string {
  return `skill_${createHash('sha256')
    .update(
      input.scope === 'shared'
        ? `shared:${input.slug}`
        : `agent:${input.ownerUserId}:${input.agentId ?? 'missing'}:${input.slug}`
    )
    .digest('hex')
    .slice(0, 24)}`;
}

function skillSlug(name: string): string {
  const normalized = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 72);
  return normalized || `skill-${createHash('sha256').update(name).digest('hex').slice(0, 12)}`;
}

function writeManagedFile(target: string, content: string): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_FILE_BYTES) {
    throw new BadRequest(`Skill file is too large: ${path.basename(target)}`);
  }
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, content.replace(/^\uFEFF/u, '').replace(/\r?\n/gu, '\n'), 'utf8');
  try {
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function safeSkillFile(skillDirectory: string, relativePath: string): string {
  const normalized = normalizeRelative(relativePath);
  if (!normalized || normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new BadRequest(`Invalid skill file path: ${relativePath}`);
  }
  const root = path.resolve(skillDirectory);
  const target = path.resolve(root, ...normalized.split('/'));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new BadRequest(`Skill file escapes its directory: ${relativePath}`);
  }
  return target;
}

function fingerprintSkillFiles(skillDirectory: string): string {
  const files: Array<{ path: string; content: string }> = [];
  const visit = (directory: string) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile()) {
        files.push({
          path: normalizeRelative(path.relative(skillDirectory, candidate)),
          content: readFileSync(candidate, 'utf8').replace(/^\uFEFF/u, ''),
        });
      }
    }
  };
  visit(skillDirectory);
  return createHash('sha256')
    .update(
      files
        .sort((left, right) => left.path.localeCompare(right.path, 'en'))
        .map(file => `${file.path}\0${file.content}`)
        .join('\0')
    )
    .digest('hex');
}

function sharedSkillsRoot(env: NodeJS.ProcessEnv): string {
  const dataHome = env.DISCO_DATA_HOME?.trim() || path.join(os.homedir(), '.disco');
  return path.join(path.resolve(dataHome), 'skills');
}

function parseSkillDescription(markdown: string, fallback: string): string {
  const frontmatter = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/u)?.[1] ?? '';
  const description = frontmatter.match(/^description:\s*(.+)$/mu)?.[1]?.trim();
  return (description?.replace(/^['"]|['"]$/gu, '') || fallback || '暂无说明。').slice(0, 600);
}

function setAgentSkillRuntimeEnabled(agentWorkspace: string, slug: string, enabled: boolean): void {
  const settingsPath = path.join(agentWorkspace, '.disco', 'capabilities.json');
  let current: { version: 1; enabled: Record<string, boolean> } = { version: 1, enabled: {} };
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/u, '')) as {
      enabled?: unknown;
    };
    if (parsed.enabled && typeof parsed.enabled === 'object' && !Array.isArray(parsed.enabled)) {
      current = {
        version: 1,
        enabled: Object.fromEntries(
          Object.entries(parsed.enabled).filter(
            (entry): entry is [string, boolean] => typeof entry[1] === 'boolean'
          )
        ),
      };
    }
  } catch {
    // A missing or malformed file is repaired from the lifecycle authority.
  }
  current.enabled[`skill:skills/${slug.toLowerCase()}/skill.md`] = enabled;
  writeManagedFile(settingsPath, `${JSON.stringify(current, null, 2)}\n`);
}

async function resolveOwnedAgent(
  db: SkillLifecycleDatabase,
  agentId: string,
  ownerUserId: UserID
): Promise<Agent> {
  const agent = await new AgentRepository(db).findOwnedById(agentId, ownerUserId);
  if (!agent || agent.state !== 'ready') {
    throw new NotFound('Agent workspace not found');
  }
  return agent;
}

function actionForInstall(existing: DiscoSkillLifecycleRecord | null): DiscoSkillAuditAction {
  return existing && existing.status !== 'uninstalled' ? 'update' : 'install';
}

function normalizedSupportingFiles(
  skillDirectory: string,
  files: DiscoSkillInstallInput['files']
): Array<{ relativePath: string; target: string; content: string }> {
  const seen = new Set<string>(['skill.md']);
  return (files ?? []).map(file => {
    const relativePath = normalizeRelative(file.relative_path);
    const key = relativePath.toLowerCase();
    if (seen.has(key)) {
      throw new BadRequest(
        key === 'skill.md'
          ? 'Supporting files cannot replace SKILL.md'
          : `Duplicate skill file path: ${file.relative_path}`
      );
    }
    seen.add(key);
    if (Buffer.byteLength(file.content, 'utf8') > MAX_SKILL_FILE_BYTES) {
      throw new BadRequest(`Skill file is too large: ${file.relative_path}`);
    }
    return {
      relativePath,
      target: safeSkillFile(skillDirectory, relativePath),
      content: file.content,
    };
  });
}

function replaceDirectoryFromStaging(target: string, staging: string): () => void {
  const backup = `${target}.backup-${process.pid}-${Date.now()}`;
  const hadTarget = existsSync(target);
  if (hadTarget) renameSync(target, backup);
  try {
    renameSync(staging, target);
  } catch (error) {
    if (hadTarget && existsSync(backup)) renameSync(backup, target);
    throw error;
  }
  return () => {
    rmSync(backup, { recursive: true, force: true });
  };
}

export interface InstallManagedDiscoSkillOptions {
  db: SkillLifecycleDatabase;
  actorUserId: UserID;
  input: DiscoSkillInstallInput;
  defaultScope: DiscoSkillScope;
  defaultAgentId?: string | null;
  sourceSessionId?: SessionID | string | null;
  env?: NodeJS.ProcessEnv;
}

export interface AdoptExistingAgentSkillOptions {
  db: SkillLifecycleDatabase;
  actorUserId: UserID;
  agent: Agent;
  relativePath: string;
  name: string;
  description: string;
  enabled: boolean;
}

/**
 * Imports a pre-lifecycle agent skill into Disco's canonical lifecycle store.
 * This keeps older/model-authored skill folders manageable without copying or
 * rewriting their runtime files.
 */
export async function adoptExistingAgentSkill(
  options: AdoptExistingAgentSkillOptions
): Promise<DiscoSkillLifecycleRecord> {
  if (options.agent.created_by !== options.actorUserId || options.agent.state !== 'ready') {
    throw new NotFound('Agent workspace not found');
  }

  const workspaceRoot = path.resolve(options.agent.workspace_path);
  const normalizedRelativePath = normalizeRelative(options.relativePath);
  const skillPath = path.resolve(workspaceRoot, ...normalizedRelativePath.split('/'));
  const skillsRoot = path.resolve(workspaceRoot, 'skills');
  const skillDirectory = path.dirname(skillPath);
  const relativeDirectory = path.relative(skillsRoot, skillDirectory);
  if (
    path.basename(skillPath).toLowerCase() !== 'skill.md' ||
    !relativeDirectory ||
    relativeDirectory.startsWith('..') ||
    path.isAbsolute(relativeDirectory) ||
    relativeDirectory.includes(path.sep)
  ) {
    throw new BadRequest('Only a direct agent skills/<name>/SKILL.md can be adopted');
  }
  if (!existsSync(skillPath)) throw new NotFound('Agent skill file not found');

  const slug = path.basename(skillDirectory);
  const id = stableSkillId({
    scope: 'agent',
    ownerUserId: options.actorUserId,
    agentId: options.agent.agent_id,
    slug,
  });
  const repository = new SkillLifecycleRepository(options.db);
  const existing = await repository.findRecord(id);
  if (existing && existing.status !== 'uninstalled') return existing;

  const now = new Date().toISOString();
  const record: DiscoSkillLifecycleRecord = {
    id,
    name: options.name.trim() || slug,
    slug,
    description: options.description.trim() || '暂无说明。',
    scope: 'agent',
    owner_user_id: options.actorUserId,
    agent_id: options.agent.agent_id,
    source: 'agent-generated',
    source_session_id: null,
    relative_path: normalizedRelativePath,
    status: options.enabled ? 'enabled' : 'disabled',
    version: (existing?.version ?? 0) + 1,
    fingerprint: fingerprintSkillFiles(skillDirectory),
    installed_at: existing?.installed_at ?? now,
    updated_at: now,
    uninstalled_at: null,
  };
  await repository.setRecord(record, options.actorUserId);
  await repository.appendAudit({
    skill: record,
    action: 'install',
    actorUserId: options.actorUserId,
    details: { imported_existing: true, previous_status: existing?.status ?? null },
  });
  setAgentSkillRuntimeEnabled(options.agent.workspace_path, slug, options.enabled);
  clearSkillCatalogCache();
  return record;
}

export async function installManagedDiscoSkill(
  options: InstallManagedDiscoSkillOptions
): Promise<DiscoSkillLifecycleRecord> {
  const name = options.input.name?.trim();
  const skillMarkdown = options.input.skill_markdown?.replace(/^\uFEFF/u, '').trim();
  if (!name) throw new BadRequest('Skill name is required');
  if (!skillMarkdown) throw new BadRequest('SKILL.md content is required');
  if ((options.input.files?.length ?? 0) > MAX_SKILL_FILES) {
    throw new BadRequest(`A skill can contain at most ${MAX_SKILL_FILES} supporting files`);
  }

  const scope = options.input.scope ?? options.defaultScope;
  const requestedAgentId = options.input.agent_id ?? options.defaultAgentId ?? null;
  let agent: Agent | undefined;
  if (scope === 'agent') {
    if (!requestedAgentId) throw new BadRequest('An agent skill requires agent_id');
    agent = await resolveOwnedAgent(options.db, requestedAgentId, options.actorUserId);
  } else if (options.input.agent_id) {
    throw new BadRequest('Shared skills cannot specify agent_id');
  }

  const slug = skillSlug(name);
  const id = stableSkillId({
    scope,
    ownerUserId: options.actorUserId,
    agentId: agent?.agent_id ?? null,
    slug,
  });
  const skillDirectory =
    scope === 'agent'
      ? path.join(agent!.workspace_path, 'skills', slug)
      : path.join(sharedSkillsRoot(options.env ?? process.env), slug);
  const repository = new SkillLifecycleRepository(options.db);
  const existing = await repository.findRecord(id);
  const now = new Date().toISOString();
  const source =
    options.input.source ?? (scope === 'shared' ? 'disco-shared' : 'agent-installed');
  const description =
    options.input.description?.trim() || parseSkillDescription(skillMarkdown, '暂无说明。');
  const stagingDirectory = `${skillDirectory}.staging-${process.pid}-${Date.now()}`;
  rmSync(stagingDirectory, { recursive: true, force: true });
  mkdirSync(stagingDirectory, { recursive: true });
  let supportingFiles: ReturnType<typeof normalizedSupportingFiles>;
  try {
    supportingFiles = normalizedSupportingFiles(stagingDirectory, options.input.files);
    writeManagedFile(path.join(stagingDirectory, 'SKILL.md'), `${skillMarkdown}\n`);
    for (const file of supportingFiles) writeManagedFile(file.target, file.content);
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
  const stagedFingerprint = fingerprintSkillFiles(stagingDirectory);
  if (
    existing &&
    existing.status === 'enabled' &&
    existing.fingerprint === stagedFingerprint &&
    existing.description === description &&
    existing.source === source &&
    existsSync(skillDirectory)
  ) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    if (scope === 'agent') setAgentSkillRuntimeEnabled(agent!.workspace_path, slug, true);
    return existing;
  }

  mkdirSync(path.dirname(skillDirectory), { recursive: true });
  const finishReplacement = replaceDirectoryFromStaging(skillDirectory, stagingDirectory);
  if (scope === 'agent') setAgentSkillRuntimeEnabled(agent!.workspace_path, slug, true);
  const skillPath = path.join(skillDirectory, 'SKILL.md');
  const record: DiscoSkillLifecycleRecord = {
    id,
    name,
    slug,
    description,
    scope,
    owner_user_id: existing?.owner_user_id ?? options.actorUserId,
    agent_id: agent?.agent_id ?? null,
    source: source as DiscoSkillOrigin,
    source_session_id:
      options.input.source_session_id ?? options.sourceSessionId?.toString() ?? null,
    relative_path:
      scope === 'agent'
        ? normalizeRelative(path.relative(agent!.workspace_path, skillPath))
        : normalizeRelative(path.relative(sharedSkillsRoot(options.env ?? process.env), skillPath)),
    status: 'enabled',
    version: (existing?.version ?? 0) + 1,
    fingerprint: stagedFingerprint,
    installed_at: existing?.installed_at ?? now,
    updated_at: now,
    uninstalled_at: null,
  };
  await repository.setRecord(record, options.actorUserId);
  await repository.appendAudit({
    skill: record,
    action: actionForInstall(existing),
    actorUserId: options.actorUserId,
    sourceSessionId: options.sourceSessionId?.toString() ?? null,
    details: {
      file_count: supportingFiles.length + 1,
      previous_version: existing?.version ?? null,
      fingerprint: record.fingerprint,
    },
  });
  finishReplacement();
  clearSkillCatalogCache();
  return record;
}

export interface PatchManagedDiscoSkillOptions {
  db: SkillLifecycleDatabase;
  actorUserId: UserID;
  skillId: string;
  patch: DiscoSkillLifecyclePatch;
  sourceSessionId?: SessionID | string | null;
  allowSharedAdminOverride?: boolean;
  env?: NodeJS.ProcessEnv;
}

async function resolveManagedSkillDirectory(
  options: PatchManagedDiscoSkillOptions,
  record: DiscoSkillLifecycleRecord
): Promise<string> {
  if (record.scope === 'shared') {
    if (
      record.owner_user_id !== options.actorUserId &&
      !options.allowSharedAdminOverride
    ) {
      throw new NotFound('Skill not found');
    }
    return path.join(sharedSkillsRoot(options.env ?? process.env), record.slug);
  }
  if (record.owner_user_id !== options.actorUserId) throw new NotFound('Skill not found');
  if (!record.agent_id) throw new NotFound('Agent skill workspace is unavailable');
  const agent = await resolveOwnedAgent(options.db, record.agent_id, options.actorUserId);
  return path.join(agent.workspace_path, 'skills', record.slug);
}

export async function patchManagedDiscoSkill(
  options: PatchManagedDiscoSkillOptions
): Promise<DiscoSkillLifecycleRecord> {
  const repository = new SkillLifecycleRepository(options.db);
  const existing = await repository.findRecord(options.skillId);
  if (!existing || existing.status === 'uninstalled') throw new NotFound('Skill not found');
  const skillDirectory = await resolveManagedSkillDirectory(options, existing);
  const now = new Date().toISOString();

  if (options.patch.action === 'uninstall') {
    if (options.patch.confirmation !== existing.name) {
      throw new BadRequest(`Type the skill name exactly to uninstall: ${existing.name}`);
    }
    rmSync(skillDirectory, { recursive: true, force: true });
    if (existing.scope === 'agent' && existing.agent_id) {
      const agent = await resolveOwnedAgent(
        options.db,
        existing.agent_id,
        options.actorUserId
      );
      setAgentSkillRuntimeEnabled(agent.workspace_path, existing.slug, false);
    }
    const uninstalled: DiscoSkillLifecycleRecord = {
      ...existing,
      status: 'uninstalled',
      version: existing.version + 1,
      updated_at: now,
      uninstalled_at: now,
    };
    await repository.setRecord(uninstalled, options.actorUserId);
    await repository.appendAudit({
      skill: uninstalled,
      action: 'uninstall',
      actorUserId: options.actorUserId,
      sourceSessionId: options.sourceSessionId?.toString() ?? null,
      details: { deleted_runtime_files: true, previous_fingerprint: existing.fingerprint },
    });
    clearSkillCatalogCache();
    return uninstalled;
  }

  const actions: DiscoSkillAuditAction[] = [];
  let fingerprint = existing.fingerprint;
  let contentChanged = false;
  if (options.patch.skill_markdown !== undefined) {
    const markdown = options.patch.skill_markdown.replace(/^\uFEFF/u, '').trim();
    if (!markdown) throw new BadRequest('SKILL.md content cannot be empty');
    const skillPath = path.join(skillDirectory, 'SKILL.md');
    const nextContent = `${markdown}\n`;
    const currentContent = existsSync(skillPath)
      ? readFileSync(skillPath, 'utf8').replace(/^\uFEFF/u, '')
      : '';
    contentChanged = currentContent !== nextContent;
    if (contentChanged) {
      writeManagedFile(skillPath, nextContent);
      fingerprint = fingerprintSkillFiles(skillDirectory);
    }
  }
  const status =
    options.patch.enabled === undefined
      ? existing.status
      : options.patch.enabled
        ? 'enabled'
        : 'disabled';
  const statusChanged = status !== existing.status;
  const description = options.patch.description?.trim() || existing.description;
  const descriptionChanged = description !== existing.description;
  if (contentChanged || descriptionChanged) actions.push('update');
  if (statusChanged) actions.push(status === 'enabled' ? 'enable' : 'disable');
  if (statusChanged && existing.scope === 'agent' && existing.agent_id) {
    const agent = await resolveOwnedAgent(
      options.db,
      existing.agent_id,
      options.actorUserId
    );
    setAgentSkillRuntimeEnabled(agent.workspace_path, existing.slug, status === 'enabled');
  }
  if (
    options.patch.enabled === undefined &&
    options.patch.skill_markdown === undefined &&
    options.patch.description === undefined
  ) {
    throw new BadRequest('No skill change was provided');
  }
  if (actions.length === 0) return existing;

  const updated: DiscoSkillLifecycleRecord = {
    ...existing,
    description,
    status,
    version: existing.version + 1,
    fingerprint,
    updated_at: now,
  };
  await repository.setRecord(updated, options.actorUserId);
  for (const action of actions) {
    await repository.appendAudit({
      skill: updated,
      action,
      actorUserId: options.actorUserId,
      sourceSessionId: options.sourceSessionId?.toString() ?? null,
      details: { previous_version: existing.version, fingerprint: updated.fingerprint },
    });
  }
  clearSkillCatalogCache();
  return updated;
}

export async function listManagedDiscoSkills(
  db: SkillLifecycleDatabase,
  filter: { ownerUserId?: UserID; scope?: DiscoSkillScope; agentId?: string; includeUninstalled?: boolean }
): Promise<DiscoSkillLifecycleRecord[]> {
  return (await new SkillLifecycleRepository(db).findRecords()).filter(record => {
    if (filter.ownerUserId && record.owner_user_id !== filter.ownerUserId) return false;
    if (filter.scope && record.scope !== filter.scope) return false;
    if (filter.agentId && record.agent_id !== filter.agentId) return false;
    if (!filter.includeUninstalled && record.status === 'uninstalled') return false;
    return true;
  });
}
