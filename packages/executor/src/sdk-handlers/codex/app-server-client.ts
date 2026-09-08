import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  resolveManagedAgenticToolPackageDirectory,
  resolveManagedAgenticToolVersion,
} from '@disco/core/agentic-integrations';
import {
  buildRuntimeCapabilityCatalog,
  CODEX_NATIVE_RUNTIME_CAPABILITIES,
  type RuntimeCapabilityCatalog,
  type RuntimeCapabilityDefinition,
} from '@disco/core';
import {
  buildHeadlessCodexCliConfigArgs,
  discoverHeadlessDisabledCodexSkillFiles,
  parseManagedCodexSkillEntries,
  resolveHeadlessCodexSkillExtraRoots,
} from './https-transport.js';

interface JsonRpcResponse<T = unknown> {
  id: number;
  result?: T;
  error?: { message?: string; code?: number; data?: unknown };
}

interface ThreadForkResult {
  thread?: { id?: string };
}

export interface CodexAppServerNotification {
  method: string;
  params: Record<string, unknown>;
  emittedAtMs?: number;
}

export type CodexDynamicToolOutputContentItem =
  | { type: 'inputText'; text: string }
  | { type: 'inputImage'; imageUrl: string }
  | { type: 'inputAudio'; audioUrl: string };

export interface CodexDynamicToolCall {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
}

export interface CodexDynamicToolCallResponse {
  contentItems: CodexDynamicToolOutputContentItem[];
  success: boolean;
}

export type CodexDynamicToolSpec =
  | {
      type: 'function';
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      deferLoading?: boolean;
    }
  | {
      type: 'namespace';
      name: string;
      description: string;
      tools: Array<{
        type: 'function';
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
        deferLoading?: boolean;
      }>;
    };

/** A client-owned tool definition and the handler for App Server callbacks. */
export interface CodexDynamicToolRegistration {
  spec: CodexDynamicToolSpec;
  execute(call: CodexDynamicToolCall): Promise<CodexDynamicToolCallResponse>;
}

interface ThreadResult {
  thread?: { id?: string };
  [key: string]: unknown;
}

interface TurnResult {
  turn?: { id?: string };
  [key: string]: unknown;
}

export interface CodexAppServerClientOptions {
  /** Extra env values to pass to the spawned `codex app-server` process. */
  env?: NodeJS.ProcessEnv;
  /** Request timeout for initialize/fork calls. Defaults to 10s. */
  timeoutMs?: number;
  /** Override executable for tests or non-standard installs. Defaults to `codex`. */
  command?: string;
  /**
   * Automatically accept command and file-change approvals for a Disco-owned
   * personal workspace. The Codex process still enforces Disco's named
   * account-boundary permission profile; this only replaces the interactive
   * approval UI that a headless app-server process cannot display.
   */
  autoApproveWorkspaceRequests?: boolean;
  /** Hard boundary applied to every headless filesystem permission grant. */
  filesystemApprovalBoundary?: DiscoFilesystemApprovalBoundary;
  /** Client-owned tools advertised through `thread/start.dynamicTools`. */
  dynamicTools?: readonly CodexDynamicToolRegistration[];
}

export interface DiscoFilesystemApprovalBoundary {
  userWorkspaceRoot: string;
  worktreesRoot: string;
}

/**
 * When the caller supplies a complete child environment, do not merge the
 * current process environment back in. That would reintroduce Codex Desktop's
 * task-scoped variables after prompt-service deliberately removed them.
 */
export function resolveCodexAppServerChildEnvironment(
  configured: NodeJS.ProcessEnv | undefined,
  inherited: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return configured ? { ...configured } : { ...inherited };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function dynamicToolMatches(
  registration: CodexDynamicToolRegistration,
  call: CodexDynamicToolCall
): boolean {
  if (registration.spec.type === 'function') {
    return call.namespace === null && registration.spec.name === call.tool;
  }
  return (
    registration.spec.name === call.namespace &&
    registration.spec.tools.some(tool => tool.name === call.tool)
  );
}

function dynamicToolCall(value: Record<string, unknown>): CodexDynamicToolCall | undefined {
  if (
    typeof value.threadId !== 'string' ||
    typeof value.turnId !== 'string' ||
    typeof value.callId !== 'string' ||
    (value.namespace !== null && typeof value.namespace !== 'string') ||
    typeof value.tool !== 'string'
  ) {
    return undefined;
  }
  return {
    threadId: value.threadId,
    turnId: value.turnId,
    callId: value.callId,
    namespace: value.namespace,
    tool: value.tool,
    arguments: value.arguments,
  };
}

function validDynamicToolOutputItem(value: unknown): value is CodexDynamicToolOutputContentItem {
  const item = record(value);
  if (!item || typeof item.type !== 'string') return false;
  if (item.type === 'inputText') return typeof item.text === 'string';
  if (item.type === 'inputImage') return typeof item.imageUrl === 'string';
  if (item.type === 'inputAudio') return typeof item.audioUrl === 'string';
  return false;
}

/**
 * Dispatch one App Server dynamic-tool callback against the definitions that
 * were advertised for this thread. Undefined means no matching client tool.
 */
export async function executeCodexDynamicToolCall(
  registrations: readonly CodexDynamicToolRegistration[],
  params: Record<string, unknown>
): Promise<CodexDynamicToolCallResponse | undefined> {
  const call = dynamicToolCall(params);
  if (!call) {
    return {
      contentItems: [{ type: 'inputText', text: 'Invalid dynamic tool call payload.' }],
      success: false,
    };
  }
  const registration = registrations.find(candidate => dynamicToolMatches(candidate, call));
  if (!registration) return undefined;
  try {
    const result = await registration.execute(call);
    if (
      typeof result?.success !== 'boolean' ||
      !Array.isArray(result.contentItems) ||
      !result.contentItems.every(validDynamicToolOutputItem)
    ) {
      return {
        contentItems: [{ type: 'inputText', text: 'Dynamic tool returned an invalid result.' }],
        success: false,
      };
    }
    return result;
  } catch (error) {
    return {
      contentItems: [
        {
          type: 'inputText',
          text: error instanceof Error ? error.message : 'Dynamic tool execution failed.',
        },
      ],
      success: false,
    };
  }
}

export function assertValidCodexDynamicTools(
  registrations: readonly CodexDynamicToolRegistration[]
): void {
  const keys = new Set<string>();
  for (const registration of registrations) {
    const spec = registration.spec;
    if (!spec.name.trim() || !spec.description.trim()) {
      throw new Error('Codex dynamic tools require non-empty names and descriptions.');
    }
    const functions =
      spec.type === 'function'
        ? [spec]
        : spec.tools.length > 0
          ? spec.tools
          : (() => {
              throw new Error(`Codex dynamic tool namespace "${spec.name}" has no tools.`);
            })();
    for (const tool of functions) {
      if (!tool.name.trim() || !tool.description.trim()) {
        throw new Error(`Codex dynamic tool in "${spec.name}" is missing metadata.`);
      }
      if (record(tool.inputSchema)?.type !== 'object') {
        throw new Error(`Codex dynamic tool "${tool.name}" requires an object input schema.`);
      }
      const key = `${spec.type === 'namespace' ? spec.name : ''}\u0000${tool.name}`;
      if (keys.has(key)) throw new Error(`Duplicate Codex dynamic tool "${tool.name}".`);
      keys.add(key);
    }
  }
}

export function codexDynamicToolRuntimeCapabilities(
  registrations: readonly CodexDynamicToolRegistration[]
): RuntimeCapabilityDefinition[] {
  assertValidCodexDynamicTools(registrations);
  return registrations.flatMap(registration => {
    const spec = registration.spec;
    const namespace = spec.type === 'namespace' ? spec.name : null;
    const tools = spec.type === 'namespace' ? spec.tools : [spec];
    return tools.map(tool => ({
      id: `client-dynamic:${namespace ? `${namespace}/` : ''}${tool.name}`,
      name: namespace ? `${namespace}.${tool.name}` : tool.name,
      provider: 'client-dynamic' as const,
      kind: 'method' as const,
      exposure: 'agent-callable' as const,
      description: tool.description,
      audiences: ['standalone', 'agent'],
      ownership: 'current-session' as const,
      outputKinds: ['text', 'image', 'audio'],
      lifecycle: 'runtime' as const,
      dependencies: ['codex-app-server', 'client-handler'],
      inputSchema: tool.inputSchema,
    }));
  });
}

/** Codex protocol plus the concrete client-owned tools advertised to a thread. */
export function buildCodexAppServerCapabilityCatalog(
  registrations: readonly CodexDynamicToolRegistration[]
): RuntimeCapabilityCatalog {
  return buildRuntimeCapabilityCatalog(
    CODEX_NATIVE_RUNTIME_CAPABILITIES,
    codexDynamicToolRuntimeCapabilities(registrations)
  );
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function containsPath(parent: string, candidate: string): boolean {
  const relative = path.relative(pathKey(parent), pathKey(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function permissionPathIsSafe(
  candidate: string,
  boundary: DiscoFilesystemApprovalBoundary,
  cwd?: string
): boolean {
  if (!path.isAbsolute(candidate) && !cwd) return false;
  const resolved = path.resolve(cwd ?? boundary.userWorkspaceRoot, candidate);
  const currentUserRoot = path.resolve(boundary.userWorkspaceRoot);
  const worktreesRoot = path.resolve(boundary.worktreesRoot);

  if (containsPath(currentUserRoot, resolved)) return true;
  // A sibling user path, the worktrees container, or an ancestor grant that
  // would encompass worktrees is forbidden. Ordinary paths elsewhere are safe.
  if (containsPath(worktreesRoot, resolved)) return false;
  if (containsPath(resolved, worktreesRoot)) return false;
  return true;
}

function permissionEntryIsSafe(
  value: unknown,
  boundary: DiscoFilesystemApprovalBoundary,
  cwd?: string
): boolean {
  const entry = record(value);
  if (!entry) return false;
  if (entry.access === 'deny') return true;
  if (entry.access !== 'read' && entry.access !== 'write') return false;
  const permissionPath = record(entry.path);
  if (!permissionPath) return false;

  if (permissionPath.type === 'path' && typeof permissionPath.path === 'string') {
    return permissionPathIsSafe(permissionPath.path, boundary, cwd);
  }
  if (permissionPath.type === 'glob_pattern') {
    // A glob may expand after approval and cross a user boundary. Exact paths
    // are required for unattended Disco grants.
    return false;
  }
  if (permissionPath.type !== 'special') return false;
  const special = record(permissionPath.value);
  const kind = special?.kind;
  if (kind === 'minimal' || kind === 'tmpdir' || kind === 'slash_tmp') return true;
  if (kind === 'project_roots') {
    const subpath = typeof special?.subpath === 'string' ? special.subpath : '.';
    return Boolean(cwd && permissionPathIsSafe(path.resolve(cwd, subpath), boundary));
  }
  if (kind === 'unknown' && typeof special?.path === 'string') {
    return permissionPathIsSafe(special.path, boundary, cwd);
  }
  // `root` would grant the sibling-user container too.
  return false;
}

function requestedPermissionProfileIsSafe(
  value: unknown,
  boundary: DiscoFilesystemApprovalBoundary,
  cwd?: string
): boolean {
  const profile = record(value);
  if (!profile) return false;
  const fileSystem = record(profile.fileSystem);
  if (!fileSystem) return true;

  for (const key of ['read', 'write'] as const) {
    const paths = fileSystem[key];
    if (paths == null) continue;
    if (!Array.isArray(paths)) return false;
    if (
      paths.some(
        candidate =>
          typeof candidate !== 'string' || !permissionPathIsSafe(candidate, boundary, cwd)
      )
    ) {
      return false;
    }
  }
  if (fileSystem.entries != null) {
    if (!Array.isArray(fileSystem.entries)) return false;
    if (fileSystem.entries.some(entry => !permissionEntryIsSafe(entry, boundary, cwd))) {
      return false;
    }
  }
  return true;
}

export function automaticWorkspaceApprovalResponse(
  method: string,
  params: Record<string, unknown> = {},
  boundary?: DiscoFilesystemApprovalBoundary
): Record<string, unknown> | undefined {
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      if (
        boundary &&
        params.additionalPermissions != null &&
        !requestedPermissionProfileIsSafe(
          params.additionalPermissions,
          boundary,
          typeof params.cwd === 'string' ? params.cwd : undefined
        )
      ) {
        return { decision: 'decline' };
      }
      const availableDecisions = Array.isArray(params.availableDecisions)
        ? params.availableDecisions
        : [];
      // Newer app-server builds tell clients exactly which decisions this
      // request supports. `acceptForSession` is not always legal (notably for
      // one-off elevated Windows commands); replying with it anyway executes
      // the command inside the unchanged read-only ACL and produces a false
      // approval. Respect the advertised one-shot decision in that case.
      if (availableDecisions.includes('acceptForSession')) {
        return { decision: 'acceptForSession' };
      }
      if (availableDecisions.includes('accept')) {
        return { decision: 'accept' };
      }
      return { decision: 'acceptForSession' };
    }
    case 'item/fileChange/requestApproval':
      if (
        boundary &&
        typeof params.grantRoot === 'string' &&
        !permissionPathIsSafe(params.grantRoot, boundary)
      ) {
        return { decision: 'decline' };
      }
      return { decision: 'acceptForSession' };
    case 'item/permissions/requestApproval': {
      if (
        !boundary ||
        !requestedPermissionProfileIsSafe(
          params.permissions,
          boundary,
          typeof params.cwd === 'string' ? params.cwd : undefined
        )
      ) {
        return undefined;
      }
      return {
        permissions: params.permissions as Record<string, unknown>,
        scope: 'turn',
        strictAutoReview: false,
      };
    }
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: 'approved_for_session' };
    default:
      return undefined;
  }
}

async function resolveBundledCodexExecutable(): Promise<string | undefined> {
  const target =
    process.platform === 'win32'
      ? process.arch === 'arm64'
        ? ['@openai/codex-win32-arm64', 'aarch64-pc-windows-msvc', 'codex.exe']
        : ['@openai/codex-win32-x64', 'x86_64-pc-windows-msvc', 'codex.exe']
      : process.platform === 'darwin'
        ? process.arch === 'arm64'
          ? ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin', 'codex']
          : ['@openai/codex-darwin-x64', 'x86_64-apple-darwin', 'codex']
        : process.arch === 'arm64'
          ? ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl', 'codex']
          : ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl', 'codex'];

  // Packaged Disco deliberately keeps SDKs in its version-aligned managed
  // integration tree rather than installing them beside the executor. A bare
  // import.meta.resolve() therefore cannot see Codex in production even though
  // loadManagedAgenticToolSdk() can. Resolve the same owned tree first.
  if (process.env.DISCO_MANAGED_AGENTIC_TOOLS === '1') {
    const version = resolveManagedAgenticToolVersion();
    if (version) {
      try {
        const platformDirectory = await resolveManagedAgenticToolPackageDirectory(
          'codex',
          version,
          target[0]
        );
        const executable = path.join(platformDirectory, 'vendor', target[1], 'bin', target[2]);
        if (existsSync(executable)) return executable;
      } catch {
        // Preserve the source/global fallbacks below so normal integration
        // diagnostics remain available when the managed tree needs repair.
      }
    }
  }

  try {
    // The SDK exports only its ESM `import` condition, so CommonJS
    // `require.resolve('@openai/codex-sdk')` cannot locate it. Resolve the ESM
    // entry first, then mirror the SDK's own platform-package lookup.
    const sdkEntry = fileURLToPath(import.meta.resolve('@openai/codex-sdk'));
    const sdkRequire = createRequire(sdkEntry);
    const codexPackage = sdkRequire.resolve('@openai/codex/package.json');
    const codexRequire = createRequire(codexPackage);
    const platformPackage = codexRequire.resolve(`${target[0]}/package.json`);
    const executable = path.join(
      path.dirname(platformPackage),
      'vendor',
      target[1],
      'bin',
      target[2]
    );
    return existsSync(executable) ? executable : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Minimal JSONL client for Codex's local App Server.
 *
 * Supports both the `thread/fork` sidecar operation and live turn execution.
 * App-server is the Codex protocol surface that exposes token-level assistant
 * deltas and explicit turn interruption; the public TypeScript SDK currently
 * exposes completed agent messages only.
 */
export class CodexAppServerClient {
  readonly runtimeCapabilityCatalog: RuntimeCapabilityCatalog;
  private readonly timeoutMs: number;
  private readonly command?: string;
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private stderr = '';
  private startPromise?: Promise<void>;
  private initializePromise?: Promise<void>;
  private readonly notificationQueue: CodexAppServerNotification[] = [];
  private readonly notificationWaiters: Array<
    (notification: CodexAppServerNotification | undefined) => void
  > = [];
  private notificationsClosed = false;

  constructor(private readonly options: CodexAppServerClientOptions = {}) {
    assertValidCodexDynamicTools(options.dynamicTools ?? []);
    this.runtimeCapabilityCatalog = buildCodexAppServerCapabilityCatalog(
      options.dynamicTools ?? []
    );
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.command = options.command;
  }

  async forkThread(threadId: string): Promise<string> {
    await this.initialize();

    const result = await this.request<ThreadForkResult>('thread/fork', {
      threadId,
      threadSource: 'disco',
    });
    const forkedThreadId = result.thread?.id;
    if (!forkedThreadId) {
      throw new Error(
        `Codex app-server thread/fork returned no thread id: ${JSON.stringify(result)}`
      );
    }
    return forkedThreadId;
  }

  async initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = (async () => {
      await this.start();
      await this.request('initialize', {
        clientInfo: { name: 'disco', title: 'Disco', version: '0.25.2' },
        capabilities: { experimentalApi: true },
      });
      this.sendNotification('initialized', {});
      const childEnvironment = resolveCodexAppServerChildEnvironment(this.options.env);
      const extraRoots = resolveHeadlessCodexSkillExtraRoots(childEnvironment);
      if (extraRoots.length > 0) {
        await this.request('skills/extraRoots/set', { extraRoots });
      }
    })();
    return this.initializePromise;
  }

  async startThread(
    params: Record<string, unknown>
  ): Promise<{ id: string; result: ThreadResult }> {
    await this.initialize();
    const result = await this.request<ThreadResult>('thread/start', params, 60_000);
    const id = result.thread?.id;
    if (!id) throw new Error(`Codex app-server thread/start returned no thread id`);
    return { id, result };
  }

  async resumeThread(
    params: Record<string, unknown>
  ): Promise<{ id: string; result: ThreadResult }> {
    await this.initialize();
    const result = await this.request<ThreadResult>('thread/resume', params, 60_000);
    const id = result.thread?.id;
    if (!id) throw new Error(`Codex app-server thread/resume returned no thread id`);
    return { id, result };
  }

  async startTurn(params: Record<string, unknown>): Promise<{ id: string; result: TurnResult }> {
    const result = await this.request<TurnResult>('turn/start', params, 60_000);
    const id = result.turn?.id;
    if (!id) throw new Error(`Codex app-server turn/start returned no turn id`);
    return { id, result };
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request('turn/interrupt', { threadId, turnId });
  }

  async steerTurn(params: {
    threadId: string;
    turnId: string;
    input: Array<Record<string, unknown>>;
  }): Promise<string> {
    const result = await this.request<{ turnId?: string }>('turn/steer', {
      threadId: params.threadId,
      expectedTurnId: params.turnId,
      input: params.input,
    });
    if (!result.turnId) throw new Error('Codex app-server turn/steer returned no turn id');
    return result.turnId;
  }

  async *notifications(): AsyncGenerator<CodexAppServerNotification> {
    while (true) {
      const notification = await this.nextNotification();
      if (!notification) return;
      yield notification;
    }
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.closeNotifications();
      return;
    }

    this.child = undefined;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Codex app-server closed before response ${id}`));
    }
    this.pending.clear();
    this.closeNotifications();

    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timedOut = new Promise<void>(resolve => {
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        resolve();
      }, 1_000).unref();
    });
    await Promise.race([exited, timedOut]);
  }

  private async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      const command = this.command ?? (await resolveBundledCodexExecutable()) ?? 'codex';
      await new Promise<void>((resolve, reject) => {
        // Apply these before app-server initialization. Thread-level config is
        // too late for plugins that are discovered while the process boots.
        const childEnvironment = resolveCodexAppServerChildEnvironment(this.options.env);
        const child = spawn(
          command,
          [
            ...buildHeadlessCodexCliConfigArgs(
              discoverHeadlessDisabledCodexSkillFiles(childEnvironment),
              parseManagedCodexSkillEntries(childEnvironment)
            ),
            'app-server',
          ],
          {
            env: childEnvironment,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          }
        );
        this.child = child;

        const rejectStartup = (error: Error) => {
          this.rejectAll(error);
          reject(error);
        };

        child.once('error', error => {
          rejectStartup(new Error(`Failed to start Codex app-server: ${error.message}`));
        });

        child.once('spawn', () => resolve());

        child.stderr.on('data', (chunk: Buffer) => {
          this.stderr += chunk.toString('utf8');
          // Keep error payloads useful without unbounded memory growth.
          if (this.stderr.length > 20_000) this.stderr = this.stderr.slice(-20_000);
        });

        child.once('exit', (code, signal) => {
          this.closeNotifications();
          this.rejectAll(
            new Error(
              `Codex app-server exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'}).${
                this.stderr ? ` stderr: ${this.stderr}` : ''
              }`
            )
          );
        });

        const rl = createInterface({ input: child.stdout });
        rl.on('line', line => this.handleLine(line));
      });
    })();

    return this.startPromise;
  }

  private request<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = this.timeoutMs
  ): Promise<T> {
    const id = this.nextId++;
    const child = this.child;
    if (!child) throw new Error('Codex app-server is not running');

    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Timed out waiting for Codex app-server response to ${method}.${
              this.stderr ? ` stderr: ${this.stderr}` : ''
            }`
          )
        );
      }, timeoutMs);
      timer.unref();

      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
      });
    });

    child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    return promise;
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    const child = this.child;
    if (!child) throw new Error('Codex app-server is not running');
    child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== 'object') return;

    if ('method' in parsed) {
      const message = parsed as {
        id?: number | string;
        method?: unknown;
        params?: unknown;
        emittedAtMs?: unknown;
      };
      if (typeof message.method !== 'string') return;
      const method = message.method;
      const requestParams =
        message.params && typeof message.params === 'object'
          ? (message.params as Record<string, unknown>)
          : {};
      if (message.id !== undefined) {
        if (process.env.DISCO_DEBUG_APP_SERVER_REQUESTS === '1') {
          console.error(
            `[Disco app-server request] ${message.method} ${JSON.stringify(requestParams)}`
          );
        }
        const automaticResponse = this.options.autoApproveWorkspaceRequests
          ? automaticWorkspaceApprovalResponse(
            method,
              requestParams,
              this.options.filesystemApprovalBoundary
            )
          : undefined;
        if (automaticResponse) {
          this.respondToServerRequest(message.id, automaticResponse);
        } else if (method === 'item/tool/call') {
          void executeCodexDynamicToolCall(this.options.dynamicTools ?? [], requestParams).then(
            result => {
              if (result) this.respondToServerRequest(message.id as number | string, result);
              else this.rejectUnsupportedServerRequest(message.id as number | string, method);
            }
          );
        } else {
          this.rejectUnsupportedServerRequest(message.id, method);
        }
        return;
      }
      this.pushNotification({
        method,
        params: requestParams,
        ...(typeof message.emittedAtMs === 'number' ? { emittedAtMs: message.emittedAtMs } : {}),
      });
      return;
    }

    if (!('id' in parsed)) return;
    const response = parsed as JsonRpcResponse;
    const pending = this.pending.get(response.id);
    if (!pending) return;

    this.pending.delete(response.id);
    clearTimeout(pending.timer);

    if (response.error) {
      pending.reject(
        new Error(
          `Codex app-server request failed: ${
            response.error.message ?? JSON.stringify(response.error)
          }`
        )
      );
      return;
    }

    pending.resolve(response.result);
  }

  private nextNotification(): Promise<CodexAppServerNotification | undefined> {
    const queued = this.notificationQueue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.notificationsClosed) return Promise.resolve(undefined);
    return new Promise(resolve => this.notificationWaiters.push(resolve));
  }

  private pushNotification(notification: CodexAppServerNotification): void {
    const waiter = this.notificationWaiters.shift();
    if (waiter) waiter(notification);
    else this.notificationQueue.push(notification);
  }

  private closeNotifications(): void {
    this.notificationsClosed = true;
    for (const waiter of this.notificationWaiters.splice(0)) waiter(undefined);
  }

  private rejectUnsupportedServerRequest(id: number | string, method: string): void {
    const child = this.child;
    if (!child) return;
    child.stdin.write(
      `${JSON.stringify({
        id,
        error: {
          code: -32601,
          message: `Disco does not support interactive app-server request ${method}`,
        },
      })}\n`
    );
  }

  private respondToServerRequest(id: number | string, result: unknown): void {
    const child = this.child;
    if (!child) return;
    child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  private rejectAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export async function forkCodexThreadViaAppServer(
  threadId: string,
  options?: CodexAppServerClientOptions
): Promise<string> {
  const client = new CodexAppServerClient(options);
  try {
    return await client.forkThread(threadId);
  } finally {
    await client.close();
  }
}
