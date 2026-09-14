import { createHash } from 'node:crypto';

/**
 * Normalized governance contract for every capability that participates in a
 * Disco session. This catalog deliberately includes non-callable protocol
 * events and UI-only features so they cannot be confused with Agent tools.
 */
export type RuntimeCapabilityProvider = 'codex-native' | 'disco-mcp' | 'client-dynamic' | 'ui-only';

export type RuntimeCapabilityKind = 'operation' | 'method' | 'event' | 'feature';

export type RuntimeCapabilityExposure =
  | 'agent-callable'
  | 'runtime-internal'
  | 'runtime-event'
  | 'ui-only';

export type RuntimeCapabilityAudience = 'standalone' | 'agent' | 'admin' | 'ui';

export type RuntimeCapabilityOwnership =
  | 'none'
  | 'current-user'
  | 'current-session'
  | 'current-agent'
  | 'shared'
  | 'explicit-target'
  | 'context-dependent';

export type RuntimeCapabilityOutputKind =
  | 'text'
  | 'interactive'
  | 'command'
  | 'file'
  | 'image'
  | 'pdf'
  | 'audio'
  | 'video'
  | 'state';

export type RuntimeCapabilityLifecycle = 'fixed' | 'runtime' | 'managed';

export interface RuntimeCapabilityDefinition {
  /** Globally unique, provider-qualified stable identifier. */
  id: string;
  /** Protocol or method name as it appears at the provider boundary. */
  name: string;
  provider: RuntimeCapabilityProvider;
  kind: RuntimeCapabilityKind;
  exposure: RuntimeCapabilityExposure;
  description: string;
  audiences: RuntimeCapabilityAudience[];
  ownership: RuntimeCapabilityOwnership;
  outputKinds: RuntimeCapabilityOutputKind[];
  lifecycle: RuntimeCapabilityLifecycle;
  dependencies: string[];
  /** Required for callable methods; absent for events and UI-only features. */
  inputSchema?: Record<string, unknown>;
}

export interface RuntimeCapabilityCatalog {
  schemaVersion: 1;
  fingerprint: string;
  entries: RuntimeCapabilityDefinition[];
}

/**
 * Stable protocol names for the small set of Disco-managed methods referenced
 * outside the daemon registry. Runtime registration remains authoritative;
 * daemon startup verifies that every required name has metadata and a handler.
 */
export const DISCO_MCP_METHOD_NAMES = {
  search: 'disco_search_tools',
  details: 'disco_get_tool_details',
  execute: 'disco_execute_tool',
  filesPublish: 'disco_files_publish',
  skillsInstall: 'disco_skills_install',
  agentMemorySave: 'disco_agent_memory_save',
  agentLearningReview: 'disco_agent_learning_review',
} as const;

/** Product-critical managed operations that must never become ghost methods. */
export const REQUIRED_DISCO_MANAGED_METHOD_NAMES = [
  DISCO_MCP_METHOD_NAMES.filesPublish,
  DISCO_MCP_METHOD_NAMES.skillsInstall,
  DISCO_MCP_METHOD_NAMES.agentMemorySave,
  DISCO_MCP_METHOD_NAMES.agentLearningReview,
] as const;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)])
  );
}

function stableCatalogEntries(
  entries: readonly RuntimeCapabilityDefinition[]
): RuntimeCapabilityDefinition[] {
  return entries
    .map((entry) => ({
      ...entry,
      audiences: [...entry.audiences].sort(),
      outputKinds: [...entry.outputKinds].sort(),
      dependencies: [...entry.dependencies].sort(),
      ...(entry.inputSchema
        ? { inputSchema: stableValue(entry.inputSchema) as Record<string, unknown> }
        : {}),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function assertValidRuntimeCapabilities(
  entries: readonly RuntimeCapabilityDefinition[]
): void {
  const ids = new Set<string>();
  const issues: string[] = [];

  for (const entry of entries) {
    if (!entry.id.trim()) issues.push('capability id is required');
    if (ids.has(entry.id)) issues.push(`${entry.id}: duplicate capability id`);
    ids.add(entry.id);
    if (!entry.name.trim()) issues.push(`${entry.id}: provider name is required`);
    if (!entry.description.trim()) issues.push(`${entry.id}: description is required`);
    if (entry.audiences.length === 0) issues.push(`${entry.id}: audience is required`);
    if (entry.outputKinds.length === 0) issues.push(`${entry.id}: output kind is required`);

    const callable = entry.exposure === 'agent-callable';
    if (callable && entry.inputSchema?.type !== 'object') {
      issues.push(`${entry.id}: callable capability requires an object input schema`);
    }
    if (!callable && entry.inputSchema !== undefined) {
      issues.push(`${entry.id}: non-callable capability must not expose an input schema`);
    }
    if (entry.provider === 'ui-only' && entry.exposure !== 'ui-only') {
      issues.push(`${entry.id}: UI-only provider must use UI-only exposure`);
    }
    if (entry.exposure === 'ui-only' && !entry.audiences.includes('ui')) {
      issues.push(`${entry.id}: UI-only capability must include the UI audience`);
    }
  }

  if (issues.length > 0) {
    throw new Error(`Invalid Disco runtime capability catalog:\n- ${issues.join('\n- ')}`);
  }
}

export function buildRuntimeCapabilityCatalog(
  ...sources: ReadonlyArray<readonly RuntimeCapabilityDefinition[]>
): RuntimeCapabilityCatalog {
  const entries = stableCatalogEntries(sources.flatMap((source) => [...source]));
  assertValidRuntimeCapabilities(entries);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ schemaVersion: 1, entries }))
    .digest('hex');
  return { schemaVersion: 1, fingerprint, entries };
}

const CODEX_SESSION_AUDIENCES: RuntimeCapabilityAudience[] = ['agent', 'standalone'];

/**
 * Codex App Server 0.149 protocol surface consumed by Disco. These are not
 * Disco MCP methods and must never appear in MCP tool search results.
 */
export const CODEX_NATIVE_RUNTIME_CAPABILITIES: RuntimeCapabilityDefinition[] = [
  {
    id: 'codex-native:thread-start',
    name: 'thread/start',
    provider: 'codex-native',
    kind: 'operation',
    exposure: 'runtime-internal',
    description: 'Create a durable Codex thread for a new Disco session.',
    audiences: CODEX_SESSION_AUDIENCES,
    ownership: 'current-session',
    outputKinds: ['state'],
    lifecycle: 'fixed',
    dependencies: ['codex-app-server'],
  },
  {
    id: 'codex-native:thread-resume',
    name: 'thread/resume',
    provider: 'codex-native',
    kind: 'operation',
    exposure: 'runtime-internal',
    description: 'Resume the durable Codex thread already bound to a Disco session.',
    audiences: CODEX_SESSION_AUDIENCES,
    ownership: 'current-session',
    outputKinds: ['state'],
    lifecycle: 'fixed',
    dependencies: ['codex-app-server'],
  },
  {
    id: 'codex-native:turn-steer',
    name: 'turn/steer',
    provider: 'codex-native',
    kind: 'operation',
    exposure: 'runtime-internal',
    description: 'Append user guidance to the currently running Codex turn.',
    audiences: CODEX_SESSION_AUDIENCES,
    ownership: 'current-session',
    outputKinds: ['state'],
    lifecycle: 'fixed',
    dependencies: ['codex-app-server'],
  },
  {
    id: 'codex-native:command-execution',
    name: 'commandExecution',
    provider: 'codex-native',
    kind: 'event',
    exposure: 'runtime-event',
    description: 'Report a Codex command execution and its output and status.',
    audiences: CODEX_SESSION_AUDIENCES,
    ownership: 'current-session',
    outputKinds: ['command', 'text'],
    lifecycle: 'fixed',
    dependencies: ['codex-app-server'],
  },
  {
    id: 'codex-native:file-change',
    name: 'fileChange',
    provider: 'codex-native',
    kind: 'event',
    exposure: 'runtime-event',
    description: 'Report file changes made by Codex in the active task.',
    audiences: CODEX_SESSION_AUDIENCES,
    ownership: 'current-session',
    outputKinds: ['file', 'state'],
    lifecycle: 'fixed',
    dependencies: ['codex-app-server'],
  },
  {
    id: 'codex-native:mcp-tool-call',
    name: 'mcpToolCall',
    provider: 'codex-native',
    kind: 'event',
    exposure: 'runtime-event',
    description: 'Report a tool call made through a configured MCP server.',
    audiences: CODEX_SESSION_AUDIENCES,
    ownership: 'context-dependent',
    outputKinds: ['text', 'state'],
    lifecycle: 'fixed',
    dependencies: ['codex-app-server', 'mcp'],
  },
  {
    id: 'codex-native:dynamic-tool-call',
    name: 'dynamicToolCall',
    provider: 'codex-native',
    kind: 'event',
    exposure: 'runtime-event',
    description: 'Report the lifecycle and result of a client-owned dynamic tool call.',
    audiences: CODEX_SESSION_AUDIENCES,
    ownership: 'context-dependent',
    outputKinds: ['text', 'image', 'audio', 'state'],
    lifecycle: 'fixed',
    dependencies: ['codex-app-server'],
  },
  {
    id: 'codex-native:image-view',
    name: 'imageView',
    provider: 'codex-native',
    kind: 'event',
    exposure: 'runtime-event',
    description: 'Report a local image inspected by Codex.',
    audiences: CODEX_SESSION_AUDIENCES,
    ownership: 'current-session',
    outputKinds: ['image'],
    lifecycle: 'fixed',
    dependencies: ['codex-app-server'],
  },
  {
    id: 'codex-native:image-generation',
    name: 'imageGeneration',
    provider: 'codex-native',
    kind: 'event',
    exposure: 'runtime-event',
    description: 'Report Codex native image generation, including the saved output path.',
    audiences: CODEX_SESSION_AUDIENCES,
    ownership: 'current-session',
    outputKinds: ['image', 'file', 'state'],
    lifecycle: 'fixed',
    dependencies: ['codex-app-server', 'codex-imagegen'],
  },
  {
    id: 'codex-native:web-search',
    name: 'webSearch',
    provider: 'codex-native',
    kind: 'event',
    exposure: 'runtime-event',
    description: 'Report a web search performed by Codex.',
    audiences: CODEX_SESSION_AUDIENCES,
    ownership: 'current-session',
    outputKinds: ['text'],
    lifecycle: 'fixed',
    dependencies: ['codex-app-server', 'network'],
  },
  {
    id: 'codex-native:plan-update',
    name: 'turn/plan/updated',
    provider: 'codex-native',
    kind: 'event',
    exposure: 'runtime-event',
    description: 'Report the current multi-step task plan and completion state.',
    audiences: CODEX_SESSION_AUDIENCES,
    ownership: 'current-session',
    outputKinds: ['state'],
    lifecycle: 'fixed',
    dependencies: ['codex-app-server'],
  },
  {
    id: 'codex-native:context-compaction',
    name: 'contextCompaction',
    provider: 'codex-native',
    kind: 'event',
    exposure: 'runtime-event',
    description: 'Report automatic compaction of earlier Codex thread context.',
    audiences: CODEX_SESSION_AUDIENCES,
    ownership: 'current-session',
    outputKinds: ['state'],
    lifecycle: 'fixed',
    dependencies: ['codex-app-server'],
  },
];

/** Human-operated product capability that must not be advertised to Agents. */
export const DISCO_UI_ONLY_RUNTIME_CAPABILITIES: RuntimeCapabilityDefinition[] = [
  {
    id: 'ui-only:analytics',
    name: 'analytics',
    provider: 'ui-only',
    kind: 'feature',
    exposure: 'ui-only',
    description:
      'View account usage, cost summaries, activity charts, and leaderboards in the Disco UI.',
    audiences: ['admin', 'ui'],
    ownership: 'current-user',
    outputKinds: ['interactive', 'state'],
    lifecycle: 'runtime',
    dependencies: ['browser-ui', 'database'],
  },
  {
    id: 'ui-only:schedules',
    name: 'schedules',
    provider: 'ui-only',
    kind: 'feature',
    exposure: 'ui-only',
    description: 'Create, edit, enable, disable, and run scheduled tasks from the Disco UI.',
    audiences: ['admin', 'ui'],
    ownership: 'current-user',
    outputKinds: ['interactive', 'state'],
    lifecycle: 'managed',
    dependencies: ['browser-ui', 'database', 'scheduler'],
  },
];
