import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentRepository,
  CodexSkillSettingsRepository,
  SkillLifecycleRepository,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@disco/core/db';
import { BadRequest, Forbidden, NotAuthenticated, NotFound } from '@disco/core/feathers';
import {
  hasMinimumRole,
  ROLES,
  type CodexSkillCatalogEntry,
  type CodexSkillRuntimeEntry,
  type CodexSkillSettingsPatch,
  type CodexSkillSource,
  type DiscoSkillInstallInput,
  type DiscoSkillLifecycleRecord,
  type Params,
  type UserID,
} from '@disco/core/types';
import { isAgentCapabilityEnabled } from './agent-capabilities.js';
import {
  clearSkillCatalogCache,
  readSkillCatalogCache,
  writeSkillCatalogCache,
} from './skill-catalog-cache.js';
import { installManagedDiscoSkill, patchManagedDiscoSkill } from './skill-lifecycle.js';

type DiscoveredCodexSkill = Omit<CodexSkillCatalogEntry, 'enabled'> & {
  skillPath: string;
};
type SkillSettingsDatabase = TenantScopeAwareDatabase | TenantScopedDatabase;

const CATALOG_CACHE_MS = 30_000;

function directoryEntries(directory: string) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function stableSkillId(stableKey: string): string {
  return `skill_${createHash('sha256').update(stableKey).digest('hex').slice(0, 24)}`;
}

function frontmatterScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Fall through to the conservative quote stripping below.
    }
  }
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readSkillMetadata(skillPath: string, fallbackName: string) {
  try {
    const content = readFileSync(skillPath, 'utf8').replace(/^\uFEFF/u, '');
    const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/u)?.[1] ?? '';
    const name = frontmatter.match(/^name:\s*(.+)$/mu)?.[1];
    const description = frontmatter.match(/^description:\s*(.+)$/mu)?.[1];
    return {
      name: name ? frontmatterScalar(name) : fallbackName,
      description: description
        ? frontmatterScalar(description).replace(/\s+/gu, ' ').slice(0, 600)
        : '该技能没有提供简介。',
    };
  } catch {
    return { name: fallbackName, description: '技能说明暂时无法读取。' };
  }
}

function discoveredSkill(input: {
  stableKey: string;
  skillPath: string;
  fallbackName: string;
  source: CodexSkillSource;
  sourceDetail: string;
}): DiscoveredCodexSkill {
  const metadata = readSkillMetadata(input.skillPath, input.fallbackName);
  return {
    id: stableSkillId(input.stableKey),
    name: metadata.name,
    description: metadata.description,
    source: input.source,
    source_detail: input.sourceDetail,
    available: true,
    skillPath: path.resolve(input.skillPath),
  };
}

function scanSkillTree(input: {
  root: string;
  stablePrefix: string;
  source: CodexSkillSource;
  sourceDetail(relativeDirectory: string): string;
  maxDepth: number;
}): DiscoveredCodexSkill[] {
  const result: DiscoveredCodexSkill[] = [];
  const visit = (directory: string, depth: number) => {
    if (depth > input.maxDepth) return;
    const skillPath = path.join(directory, 'SKILL.md');
    if (existsSync(skillPath)) {
      const relativeDirectory = normalizeRelative(path.relative(input.root, directory));
      result.push(
        discoveredSkill({
          stableKey: `${input.stablePrefix}/${relativeDirectory.toLowerCase()}`,
          skillPath,
          fallbackName: path.basename(directory),
          source: input.source,
          sourceDetail: input.sourceDetail(relativeDirectory),
        })
      );
      return;
    }
    for (const entry of directoryEntries(directory)) {
      if (entry.isDirectory()) visit(path.join(directory, entry.name), depth + 1);
    }
  };
  if (existsSync(input.root)) visit(input.root, 0);
  return result;
}

function resolveCodexHomes(env: NodeJS.ProcessEnv): string[] {
  const runtimeHome =
    env.DISCO_CODEX_RUNTIME_HOME?.trim() ||
    (env.DISCO_DATA_HOME?.trim()
      ? path.join(path.dirname(path.resolve(env.DISCO_DATA_HOME)), 'codex-runtime')
      : undefined);
  // Prefer Disco's isolated Runtime Home. Codex discovers its built-in
  // SYSTEM skills there automatically; selecting the same skill from the
  // desktop home as the managed entry would advertise two copies at runtime
  // and make the Settings toggle control the wrong file.
  return [runtimeHome, env.CODEX_HOME, env.DISCO_HOST_CODEX_HOME, path.join(os.homedir(), '.codex')]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => path.resolve(value))
    .filter((value, index, all) => all.indexOf(value) === index);
}

function scanCodexHome(codexHome: string): DiscoveredCodexSkill[] {
  // Inherit the two official Codex surfaces: built-in SYSTEM skills and
  // skills shipped by installed OpenAI plugins. Personal ~/.codex/skills and
  // conversation-generated memory remain outside Disco's trust boundary.
  const systemSkills = scanSkillTree({
    root: path.join(codexHome, 'skills', '.system'),
    stablePrefix: 'codex:official',
    source: 'codex-sync',
    sourceDetail: () => 'Codex 官方',
    maxDepth: 2,
  });
  const pluginSkills: DiscoveredCodexSkill[] = [];
  const pluginCache = path.join(codexHome, 'plugins', 'cache');
  for (const publisher of ['openai-bundled', 'openai-primary-runtime', 'openai-curated-remote']) {
    const publisherRoot = path.join(pluginCache, publisher);
    for (const pluginEntry of directoryEntries(publisherRoot)) {
      if (!pluginEntry.isDirectory() || pluginEntry.name.startsWith('plugin-backup-')) continue;
      const pluginRoot = path.join(publisherRoot, pluginEntry.name);
      // Curated remote packages leave an explicit install receipt. Without it
      // a cache directory may merely be a downloaded recommendation.
      if (
        publisher === 'openai-curated-remote' &&
        !existsSync(path.join(pluginRoot, '.codex-remote-plugin-install.json'))
      ) {
        continue;
      }
      const versions = directoryEntries(pluginRoot)
        .filter(
          (entry) =>
            entry.isDirectory() &&
            existsSync(path.join(pluginRoot, entry.name, '.codex-plugin', 'plugin.json'))
        )
        .sort((left, right) =>
          right.name.localeCompare(left.name, 'en', { numeric: true, sensitivity: 'base' })
        );
      for (const version of versions) {
        const discovered = scanSkillTree({
          root: path.join(pluginRoot, version.name, 'skills'),
          stablePrefix: `codex:official-plugin:${publisher}/${pluginEntry.name}`,
          source: 'codex-sync',
          sourceDetail: () => `Codex 官方插件 · ${pluginEntry.name}`,
          maxDepth: 3,
        });
        if (discovered.length === 0) continue;
        pluginSkills.push(...discovered);
        break;
      }
    }
  }
  return [...systemSkills, ...pluginSkills];
}

function scanDiscoLocalSkills(env: NodeJS.ProcessEnv): DiscoveredCodexSkill[] {
  const dataHome = env.DISCO_DATA_HOME?.trim() || path.join(os.homedir(), '.disco');
  return scanSkillTree({
    root: path.join(dataHome, 'skills'),
    stablePrefix: 'disco:skills',
    source: 'disco-local',
    sourceDetail: () => 'Disco 本地安装',
    maxDepth: 3,
  });
}

function discoLocalSkillsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const dataHome = env.DISCO_DATA_HOME?.trim() || path.join(os.homedir(), '.disco');
  return path.resolve(dataHome, 'skills');
}

function scanAgentWorkspaceSkills(workspacePath: string): DiscoveredCodexSkill[] {
  const root = path.resolve(workspacePath);
  return scanSkillTree({
    root: path.join(root, 'skills'),
    stablePrefix: `agent:${createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 16)}`,
    source: 'agent-generated',
    sourceDetail: () => '当前智能体自生成',
    maxDepth: 2,
  }).map((skill) => ({
    ...skill,
    available: true,
  }));
}

function resolveAgentWorkspaceRoot(workspacePath: string): string | undefined {
  let candidate = path.resolve(workspacePath);
  while (true) {
    if (existsSync(path.join(candidate, '.disco', 'agent.json'))) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

export function discoverCodexSkills(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now()
): DiscoveredCodexSkill[] {
  const cachedCatalog = readSkillCatalogCache<DiscoveredCodexSkill>(now);
  if (cachedCatalog) return cachedCatalog.entries;
  const deduplicated = new Map<string, DiscoveredCodexSkill>();
  for (const codexHome of resolveCodexHomes(env)) {
    for (const skill of scanCodexHome(codexHome)) {
      if (!deduplicated.has(skill.id)) deduplicated.set(skill.id, skill);
    }
  }
  for (const skill of scanDiscoLocalSkills(env)) {
    if (!deduplicated.has(skill.id)) deduplicated.set(skill.id, skill);
  }
  const entries = [...deduplicated.values()].sort(
    (left, right) =>
      left.source.localeCompare(right.source) || left.name.localeCompare(right.name, 'zh-CN')
  );
  writeSkillCatalogCache({ expiresAt: now + CATALOG_CACHE_MS, entries });
  return entries;
}

export function clearCodexSkillCatalogCache(): void {
  clearSkillCatalogCache();
}

async function catalogWithSettings(
  db: SkillSettingsDatabase,
  workspacePath?: string
): Promise<Array<DiscoveredCodexSkill & { enabled: boolean }>> {
  const overrides = await new CodexSkillSettingsRepository(db).find();
  const lifecycleRecords = await new SkillLifecycleRepository(db).findRecords();
  const sharedRecords = new Map(
    lifecycleRecords
      .filter((record) => record.scope === 'shared' && record.status !== 'uninstalled')
      .map((record) => [normalizeRelative(record.relative_path).toLowerCase(), record])
  );
  const sharedRoot = discoLocalSkillsRoot();
  const shared = discoverCodexSkills().map((skill) => {
    const relativePath = normalizeRelative(
      path.relative(sharedRoot, skill.skillPath)
    ).toLowerCase();
    const lifecycle = skill.source === 'disco-local' ? sharedRecords.get(relativePath) : undefined;
    return {
      ...skill,
      id: lifecycle?.id ?? skill.id,
      lifecycle,
      enabled: lifecycle
        ? skill.available && lifecycle.status === 'enabled'
        : skill.available && (overrides[skill.id] ?? true),
    };
  });
  if (!workspacePath) return shared;
  const agentWorkspace = resolveAgentWorkspaceRoot(workspacePath);
  if (!agentWorkspace) return shared;
  const candidateAgentRecords = lifecycleRecords.filter(
    (record) => record.scope === 'agent' && record.status !== 'uninstalled' && record.agent_id
  );
  const agentRepository = new AgentRepository(db);
  const matchingAgentRecords = (
    await Promise.all(
      candidateAgentRecords.map(async (record) => {
        const agent = await agentRepository.findById(record.agent_id!);
        return agent?.workspace_path &&
          path.resolve(agent.workspace_path) === path.resolve(agentWorkspace)
          ? record
          : null;
      })
    )
  ).filter((record): record is DiscoSkillLifecycleRecord => Boolean(record));
  const agentRecords = new Map(
    matchingAgentRecords.map((record) => [
      normalizeRelative(record.relative_path).toLowerCase(),
      record,
    ])
  );
  const agentSkills = scanAgentWorkspaceSkills(agentWorkspace).map((skill) => {
    const relativePath = normalizeRelative(path.relative(agentWorkspace, skill.skillPath));
    const lifecycle = agentRecords.get(relativePath.toLowerCase());
    return {
      ...skill,
      id: lifecycle?.id ?? skill.id,
      lifecycle,
      enabled:
        skill.available &&
        (lifecycle
          ? lifecycle.status === 'enabled'
          : isAgentCapabilityEnabled(agentWorkspace, 'skill', relativePath)),
    };
  });
  return [...shared, ...agentSkills];
}

export async function resolveCodexSkillRuntimeEntries(
  db: SkillSettingsDatabase,
  options: { workspacePath?: string } = {}
): Promise<CodexSkillRuntimeEntry[]> {
  return (await catalogWithSettings(db, options.workspacePath)).map((skill) => ({
    path: skill.skillPath,
    enabled: skill.enabled,
  }));
}

function publicEntry(skill: DiscoveredCodexSkill & { enabled: boolean }): CodexSkillCatalogEntry {
  const { skillPath: _skillPath, ...entry } = skill;
  return entry;
}

export class CodexSkillsService {
  constructor(private db: TenantScopeAwareDatabase) {}

  async find(_params?: Params): Promise<CodexSkillCatalogEntry[]> {
    return (await catalogWithSettings(this.db)).map(publicEntry);
  }

  async get(id: string, _params?: Params): Promise<CodexSkillCatalogEntry> {
    const skill = (await catalogWithSettings(this.db)).find((entry) => entry.id === id);
    if (!skill) throw new NotFound(`Skill not found: ${id}`);
    return publicEntry(skill);
  }

  async create(data: DiscoSkillInstallInput, params?: Params): Promise<CodexSkillCatalogEntry> {
    const actorUserId = (params as { user?: { user_id?: UserID } } | undefined)?.user?.user_id;
    if (!actorUserId) throw new NotAuthenticated('Authentication required');
    const record = await installManagedDiscoSkill({
      db: this.db,
      actorUserId,
      input: { ...data, scope: 'shared' },
      defaultScope: 'shared',
      sourceSessionId: data.source_session_id ?? null,
    });
    const skill = (await catalogWithSettings(this.db)).find((entry) => entry.id === record.id);
    if (!skill) throw new NotFound(`Installed skill not found: ${record.id}`);
    return publicEntry(skill);
  }

  async patch(
    id: string,
    data: CodexSkillSettingsPatch,
    params?: Params
  ): Promise<CodexSkillCatalogEntry> {
    const actorUserId = (params as { user?: { user_id?: UserID } } | undefined)?.user?.user_id;
    if (!actorUserId) throw new NotAuthenticated('Authentication required');
    const actorRole = (params as { user?: { role?: string } } | undefined)?.user?.role;
    const isAdmin = hasMinimumRole(actorRole, ROLES.ADMIN);
    const managed = await new SkillLifecycleRepository(this.db).findRecord(id);
    if (managed) {
      // The global settings endpoint is the authority for shared skills only.
      // Agent-scoped skills must be managed through agent-capabilities so that
      // ownership and the selected Agent workspace are both verified.
      if (managed.scope !== 'shared') throw new NotFound(`Skill not found: ${id}`);
      const updated = await patchManagedDiscoSkill({
        db: this.db,
        actorUserId,
        skillId: id,
        patch: data,
        allowSharedAdminOverride: isAdmin,
      });
      if (updated.status === 'uninstalled') {
        return {
          id: updated.id,
          name: updated.name,
          description: updated.description,
          source: 'disco-local',
          source_detail: 'Disco 本地安装',
          enabled: false,
          available: false,
          unavailable_reason: '该技能已卸载，审计记录仍保留。',
          lifecycle: updated,
        };
      }
      const refreshed = (await catalogWithSettings(this.db)).find((entry) => entry.id === id);
      if (!refreshed) throw new NotFound(`Skill not found after update: ${id}`);
      return publicEntry(refreshed);
    }
    if (typeof data?.enabled !== 'boolean') {
      throw new BadRequest('Official Codex skills only support enabled changes');
    }
    if (!isAdmin) throw new Forbidden('Only administrators can manage Codex official skills');
    const skill = discoverCodexSkills().find((entry) => entry.id === id);
    if (!skill) throw new NotFound(`Skill not found: ${id}`);
    if (data.enabled && !skill.available) {
      throw new BadRequest(skill.unavailable_reason || 'This skill is unavailable in Disco.');
    }
    await new CodexSkillSettingsRepository(this.db).patch(id, data.enabled, actorUserId);
    return publicEntry({ ...skill, enabled: skill.available && data.enabled });
  }
}

export function createCodexSkillsService(db: TenantScopeAwareDatabase): CodexSkillsService {
  return new CodexSkillsService(db);
}
