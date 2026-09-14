/**
 * CodexPromptService Tests
 *
 * Focused test: Verify SDK instance caching to prevent memory leak (issue #133)
 *
 * KNOWN GAP: the `MockCodexClient` below captures `apiKey`, `baseUrl`, and
 * `config` only shallowly; it still does not emulate Codex CLI process
 * behavior or subscription-mode env scrubbing. Some streaming tests stub out
 * `ensureCodexInstructionsFile`, `buildMcpServersConfig`, and
 * `ensureCodexClient`. So the load-bearing behaviors of the
 * per-session-CODEX_HOME removal —
 * `model_instructions_file` injection, MCP server flattening, subscription-
 * mode env scrubbing, fingerprint-based cache invalidation on token rotation
 * — are NOT exercised here. End-to-end coverage for those lives in the
 * manual test matrix in PR #1136. A proper SDK-call-shape assertion suite
 * is queued as a follow-up.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDefaultDiscoAgentProfile } from '@disco/core';
import type { SessionUpdate } from '@disco/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MessagesRepository,
  SessionMCPServerRepository,
  SessionRepository,
} from '../../db/feathers-repositories.js';
import type { Message, PermissionMode, SessionID } from '../../types.js';
import type { MessagesService } from '../base/index.js';

// Existing unit fixtures model the public SDK event stream. App-server has a
// dedicated adapter suite; keep these fixtures on the rollback transport.
process.env.DISCO_CODEX_EXECUTION_TRANSPORT = 'sdk';

const TEST_WORKING_DIRECTORY = path.join(
  os.tmpdir(),
  'disco-test-worktrees',
  'user-test',
  'standalone',
  'session'
);

const appServerMocks = vi.hoisted(() => ({
  forkCodexThreadViaAppServer: vi.fn(),
}));

const mcpScopingMocks = vi.hoisted(() => ({
  getMcpServersForSession: vi.fn(),
}));

const mcpAuthMocks = vi.hoisted(() => ({
  resolveMCPAuthHeaders: vi.fn(),
}));

const configMocks = vi.hoisted(() => ({
  getDaemonUrl: vi.fn(),
}));

const uploadMocks = vi.hoisted(() => ({
  materializeUploadToWorkspace: vi.fn(),
}));

import { CodexTool } from './codex-tool.js';
import {
  buildCodexHttpsTransportConfig,
  buildHeadlessCodexCliConfigArgs,
  discoverHeadlessDisabledCodexSkillFiles,
  HEADLESS_DISABLED_CODEX_PLUGINS,
  parseManagedCodexSkillEntries,
  resolveHeadlessCodexSkillExtraRoots,
} from './https-transport.js';
import {
  appendExplicitlyPublishedOutputs,
  appendVerifiedToolOutcomeNotices,
  buildDiscoCodexChildEnvironment,
  buildDiscoManagedLifecycleInstruction,
  buildDiscoRuntimeAccessBoundary,
  CodexPromptService,
  countFailedExplicitPublications,
  extractExplicitlyPublishedAttachments,
  resolveDiscoCodexRuntimeHome,
  unrecoveredMethodFailureNames,
} from './prompt-service.js';

describe('Codex HTTPS transport selection', () => {
  it('uses the HTTPS Responses provider for ChatGPT subscription auth', () => {
    const config = buildCodexHttpsTransportConfig({
      config: { service_tier: 'default' },
      useNativeAuth: true,
    });

    expect(config).toMatchObject({
      service_tier: 'default',
      features: {
        js_repl: false,
        memories: false,
        external_agent_memory_import: false,
      },
      model_provider: 'disco_openai_https',
      model_providers: {
        disco_openai_https: {
          base_url: 'https://chatgpt.com/backend-api/codex',
          wire_api: 'responses',
          requires_openai_auth: true,
          supports_websockets: false,
        },
      },
    });
    for (const plugin of HEADLESS_DISABLED_CODEX_PLUGINS) {
      expect((config.plugins as Record<string, { enabled?: boolean }>)[plugin]?.enabled).toBe(
        false
      );
    }
  });

  it('disables desktop-only plugins before app-server initialization', () => {
    const skillFile = 'C:/Codex/plugins/browser/skills/control-in-app-browser/SKILL.md';
    const args = buildHeadlessCodexCliConfigArgs([skillFile]);
    for (const plugin of HEADLESS_DISABLED_CODEX_PLUGINS) {
      expect(args).toContain(`plugins.${JSON.stringify(plugin)}.enabled=false`);
    }
    expect(args).toContain('features.js_repl=false');
    expect(args).toContain('features.memories=false');
    expect(args).toContain('features.external_agent_memory_import=false');
    expect(args).toContain('notify=[]');
    expect(args).toContain(`skills.config=[{path=${JSON.stringify(skillFile)},enabled=false}]`);
  });

  it('discovers versioned desktop-control skill files from CODEX_HOME', async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'disco-headless-skills-'));
    const skillFile = path.join(
      codexHome,
      'plugins',
      'cache',
      'openai-bundled',
      'browser',
      '99.1',
      'skills',
      'control-in-app-browser',
      'SKILL.md'
    );
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.writeFile(skillFile, '# Browser');

    try {
      expect(
        discoverHeadlessDisabledCodexSkillFiles({
          CODEX_HOME: codexHome,
          DISCO_HOST_CODEX_HOME: codexHome,
        })
      ).toContain(skillFile.replace(/\\/g, '/'));
    } finally {
      await fs.rm(codexHome, { recursive: true, force: true });
    }
  });

  it('applies managed skill toggles and keeps desktop skills disabled', () => {
    const documents = path.resolve('C:/Codex/skills/documents/SKILL.md');
    const browser = path.resolve('C:/Codex/plugins/browser/SKILL.md');
    const parsed = parseManagedCodexSkillEntries({
      DISCO_CODEX_SKILLS_CONFIG: JSON.stringify([
        { path: documents, enabled: true },
        { path: browser, enabled: true },
        { path: 'relative/SKILL.md', enabled: true },
      ]),
    });
    expect(parsed).toEqual([
      { path: documents, enabled: true },
      { path: browser, enabled: true },
    ]);

    const args = buildHeadlessCodexCliConfigArgs([browser], parsed);
    const skillsArg = args.find((arg) => arg.startsWith('skills.config='));
    expect(skillsArg).toContain(
      `path=${JSON.stringify(documents.replace(/\\/g, '/'))},enabled=true`
    );
    expect(skillsArg).toContain(
      `path=${JSON.stringify(browser.replace(/\\/g, '/'))},enabled=false`
    );

    const extraRoots = resolveHeadlessCodexSkillExtraRoots({
      DISCO_CODEX_SKILLS_CONFIG: JSON.stringify([
        { path: documents, enabled: true },
        { path: browser, enabled: false },
      ]),
      CODEX_HOME: path.resolve('C:/empty-codex-home'),
      DISCO_HOST_CODEX_HOME: path.resolve('C:/empty-codex-home'),
    });
    expect(extraRoots).toEqual(
      expect.arrayContaining([
        path.dirname(path.dirname(browser)),
        path.dirname(path.dirname(documents)),
      ])
    );
  });

  it('preserves a custom API endpoint but disables its WebSocket transport', () => {
    expect(
      buildCodexHttpsTransportConfig({
        config: { features: { goals: false } },
        apiKey: 'key',
        baseUrl: 'https://gateway.example.test/v1',
        useNativeAuth: false,
      })
    ).toMatchObject({
      features: { goals: false },
      model_providers: {
        disco_openai_https: {
          base_url: 'https://gateway.example.test/v1',
          env_key: 'CODEX_API_KEY',
          supports_websockets: false,
        },
      },
    });
  });
});

describe('Codex generated output discovery', () => {
  it('resolves Disco runtime home without inheriting the desktop Codex home', () => {
    expect(
      resolveDiscoCodexRuntimeHome({
        DISCO_CODEX_RUNTIME_HOME: 'E:/Disco/data/codex-runtime',
        CODEX_HOME: 'C:/Users/test/.codex',
      })
    ).toBe(path.resolve('E:/Disco/data/codex-runtime'));
    expect(
      resolveDiscoCodexRuntimeHome({
        DISCO_DATA_HOME: 'E:/Disco/data/disco',
        CODEX_HOME: 'C:/Users/test/.codex',
      })
    ).toBe(path.resolve('E:/Disco/data/codex-runtime'));
  });

  it('keeps ordinary Disco variables but removes inherited Codex Desktop task identity', () => {
    const env = buildDiscoCodexChildEnvironment(
      {
        PATH: 'disco-path',
        HOME: 'E:/Disco/home',
        DISCO_CODEX_SKILLS_CONFIG: '[{"name":"documents"}]',
        CODEX_HOME: 'C:/Users/test/.codex',
        CODEX_API_KEY: 'desktop-key',
        OPENAI_API_KEY: 'openai-key',
        CODEX_SESSION_ID: 'desktop-session',
        CODEX_THREAD_ID: 'desktop-thread',
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop',
        CODEX_CI: '1',
        CODEX_PERMISSION_PROFILE: ':danger-full-access',
      },
      {
        codexHome: 'E:/Disco/data/codex-runtime',
        useSubscription: true,
      }
    );

    expect(env).toMatchObject({
      PATH: 'disco-path',
      HOME: 'E:/Disco/home',
      DISCO_CODEX_SKILLS_CONFIG: '[{"name":"documents"}]',
      CODEX_HOME: 'E:/Disco/data/codex-runtime',
    });
    for (const key of [
      'CODEX_API_KEY',
      'OPENAI_API_KEY',
      'CODEX_SESSION_ID',
      'CODEX_THREAD_ID',
      'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
      'CODEX_CI',
      'CODEX_PERMISSION_PROFILE',
    ]) {
      expect(env).not.toHaveProperty(key);
    }
  });

  it('passes only Disco-owned Codex variables in API-key mode', () => {
    const env = buildDiscoCodexChildEnvironment(
      {
        PATH: 'disco-path',
        CODEX_SESSION_ID: 'desktop-session',
        CODEX_HOME: 'C:/Users/test/.codex',
      },
      {
        codexHome: 'E:/Disco/data/codex-runtime',
        apiKey: 'disco-key',
      }
    );

    expect(env.CODEX_HOME).toBe('E:/Disco/data/codex-runtime');
    expect(env.CODEX_API_KEY).toBe('disco-key');
    expect(env).not.toHaveProperty('CODEX_SESSION_ID');
  });

  it('builds a short runtime-only soft boundary for the current Disco user', () => {
    const userRoot = path.resolve('E:/Disco/data/disco/worktrees/user-reskip');
    const text = buildDiscoRuntimeAccessBoundary(userRoot);

    expect(text).toContain(`# Disco 用户目录边界`);
    expect(text).toContain(`当前用户目录：\`${userRoot}\``);
    expect(text).toContain(`用户目录根：\`${path.dirname(userRoot)}\``);
    expect(text).toContain('当前用户目录内的全部内容');
    expect(text).toContain('不要访问用户目录根下属于其他 Disco 用户的目录');
    expect(text).toContain('以最终解析后的路径为准');
    expect(text).toContain('本规则仅用于当前运行');
    expect(text).toContain('不要写入智能体的人格、记忆或技能');
    expect(text).not.toContain('多步骤任务计划');
    expect(text).not.toContain('只完成第一步');
    expect(text).not.toContain('Git');
    expect(text).not.toContain('branch');
    expect(text).not.toContain('sandbox_permissions');
    expect(text).not.toContain('ACL');
  });

  it('routes managed operations through the live catalog without embedding method names', () => {
    const agentText = buildDiscoManagedLifecycleInstruction({ agentSession: true });
    const standaloneText = buildDiscoManagedLifecycleInstruction({ agentSession: false });

    expect(agentText).toContain('默认目标是当前智能体');
    expect(agentText).toContain('使用 Disco 托管记忆方法');
    expect(agentText).toContain('不要通过 Shell 直接修改长期记忆文件');
    expect(standaloneText).toContain('Disco 共享技能');
    expect(standaloneText).toContain('独立会话不保存人格或长期记忆');
    for (const text of [agentText, standaloneText]) {
      expect(text).toContain('Windows PowerShell 读写文本时显式指定 UTF-8');
      expect(text).toContain('具体方法名和输入结构以当前 Disco 工具目录为准');
      expect(text).not.toMatch(/`disco_[a-z0-9_]+`/u);
    }
  });

  it('accepts files only from a successful explicit Disco publication result', () => {
    const payload = {
      type: 'disco_file_publication',
      published: true,
      files: [
        {
          ref: 'upl_00000000-0000-4000-8000-000000000001',
          filename: '结果.png',
          mimeType: 'image/png',
          size: 42,
        },
      ],
    };
    expect(
      extractExplicitlyPublishedAttachments([
        {
          id: 'publish-1',
          name: 'disco.disco_execute_tool',
          input: { tool_name: 'disco_files_publish', arguments: { files: [] } },
          output: [{ type: 'text', text: JSON.stringify(payload) }],
          status: 'completed',
        },
      ])
    ).toEqual(payload.files);
  });

  it('does not infer publication from prose, command paths, failed tools, or unrelated tools', () => {
    expect(
      extractExplicitlyPublishedAttachments([
        {
          id: 'command-1',
          name: 'Bash',
          input: { command: 'generate output/result.png' },
          output: 'created output/result.png',
          status: 'completed',
        },
        {
          id: 'publish-failed',
          name: 'disco.disco_files_publish',
          input: { files: [{ path: 'output/result.png' }] },
          output: JSON.stringify({
            type: 'disco_file_publication',
            published: true,
            files: [{ ref: 'upl_bad', filename: 'result.png', mimeType: 'image/png', size: 1 }],
          }),
          status: 'failed',
        },
      ])
    ).toEqual([]);
  });

  it('marks failed or malformed publication attempts as undelivered', () => {
    const attempts = [
      {
        id: 'failed',
        name: 'disco.disco_files_publish',
        input: { files: [{ path: 'output/result.png' }] },
        output: 'permission denied',
        status: 'failed',
      },
      {
        id: 'malformed',
        name: 'disco.disco_execute_tool',
        input: { tool_name: 'disco_files_publish', arguments: { files: [] } },
        output: JSON.stringify({ published: false }),
        status: 'completed',
      },
      {
        id: 'unrelated',
        name: 'Bash',
        input: { command: 'echo ok' },
        output: 'ok',
        status: 'completed',
      },
    ];

    expect(countFailedExplicitPublications(attempts)).toBe(2);
  });

  it('adds a truthful user-visible warning when prose claims a failed file was sent', () => {
    const content = [{ type: 'text', text: '图片已经发给你了。' }];
    appendExplicitlyPublishedOutputs({
      content,
      toolUses: [
        {
          id: 'publish-failed',
          name: 'disco.disco_files_publish',
          input: { files: [{ path: 'output/result.png' }] },
          output: 'file not found',
          status: 'failed',
        },
      ],
    });

    expect(content).toEqual([
      { type: 'text', text: '图片已经发给你了。' },
      {
        type: 'text',
        text: '⚠️ 文件交付未完成：1 次发布调用失败或未返回有效文件。回复中提到的本地文件名不代表文件已经发送。',
      },
    ]);
  });

  it('reports unrecovered callable-method failures but not a later successful retry', () => {
    const failed = {
      id: 'method-failed',
      name: 'github.search',
      input: { query: 'disco' },
      output: 'capacity',
      status: 'failed',
    };
    expect(unrecoveredMethodFailureNames([failed])).toEqual(['github.search']);
    expect(
      unrecoveredMethodFailureNames([
        failed,
        { ...failed, id: 'method-retried', output: 'ok', status: 'completed' },
      ])
    ).toEqual([]);
  });

  it('attributes proxied Disco failures to the real inner method', () => {
    const failed = {
      id: 'method-failed',
      name: 'disco.disco_execute_tool',
      input: {
        tool_name: 'disco_messages_list',
        arguments: {
          search: '跑步',
          createdAfter: '2026-08-01',
          createdBefore: '2026-09-01T23:59:59+08:00',
        },
      },
      output: 'validation error',
      status: 'failed',
    };

    expect(unrecoveredMethodFailureNames([failed])).toEqual(['disco_messages_list']);
    expect(
      unrecoveredMethodFailureNames([
        failed,
        { ...failed, id: 'method-retried', output: 'ok', status: 'completed' },
      ])
    ).toEqual([]);
  });

  it('recognizes a corrected learning summary as a retry of the same task and phase', () => {
    const failed = {
      id: 'review-first',
      name: 'disco.disco_execute_tool',
      status: 'failed',
      input: {
        tool_name: 'disco_agent_learning_review',
        arguments: { taskId: 'task-a', phase: 'complete', memoryDecision: 'saved' },
      },
      output: 'Memory consolidation is due',
    };
    const success = {
      ...failed,
      id: 'review-retry',
      status: 'completed',
      output: '{"reviewed":true}',
      input: {
        ...failed.input,
        arguments: {
          taskId: 'task-a',
          phase: 'complete',
          memoryDecision: 'consolidated',
          consolidation: { content: 'summary' },
        },
      },
    };
    expect(unrecoveredMethodFailureNames([failed, success])).toEqual([]);
    expect(unrecoveredMethodFailureNames([success, failed])).toEqual([
      'disco_agent_learning_review',
    ]);
    expect(
      unrecoveredMethodFailureNames([
        failed,
        {
          ...success,
          input: { ...success.input, arguments: { taskId: 'task-a', phase: 'inspect' } },
        },
      ])
    ).toEqual(['disco_agent_learning_review']);
    expect(
      unrecoveredMethodFailureNames([
        failed,
        {
          ...success,
          input: { ...success.input, arguments: { taskId: 'task-b', phase: 'complete' } },
        },
      ])
    ).toEqual(['disco_agent_learning_review']);
  });

  it('does not use an earlier success to hide a later failed method call', () => {
    const use = {
      id: 'one',
      name: 'github.get_repository',
      input: { owner: 'reskip', repo: 'Disco' },
      output: 'ok',
      status: 'completed',
    };
    expect(
      unrecoveredMethodFailureNames([
        use,
        { ...use, id: 'two', output: 'forbidden', status: 'failed' },
      ])
    ).toEqual(['github.get_repository']);
  });

  it('adds a final truth notice for an unrecovered method failure', () => {
    const content = [{ type: 'text', text: '仓库信息已读取。' }];
    appendVerifiedToolOutcomeNotices({
      content,
      toolUses: [
        {
          id: 'method-failed',
          name: 'github.get_repository',
          input: { owner: 'openai', repo: 'codex' },
          output: 'forbidden',
          status: 'failed',
        },
      ],
    });

    expect(content.at(-1)?.text).toBe(
      '⚠️ 以下方法调用未完成：github.get_repository。如回复声称这些操作已经成功，应以此失败状态为准。'
    );
  });

  it('deduplicates repeated publication results by upload reference', () => {
    const payload = JSON.stringify({
      type: 'disco_file_publication',
      published: true,
      files: [{ ref: 'upl_same', filename: '报告.pdf', mimeType: 'application/pdf', size: 8 }],
    });
    expect(
      extractExplicitlyPublishedAttachments([
        {
          id: 'one',
          name: 'disco.disco_files_publish',
          input: { files: [] },
          output: payload,
          status: 'completed',
        },
        {
          id: 'two',
          name: 'disco.disco_files_publish',
          input: { files: [] },
          output: payload,
          status: 'completed',
        },
      ])
    ).toHaveLength(1);
  });

  it('always appends canonical attachment metadata even when prose links the local file', () => {
    const content = [{ type: 'text', text: '下载 [报告](output/报告.pdf)' }];
    appendExplicitlyPublishedOutputs({
      content,
      toolUses: [
        {
          id: 'publish-report',
          name: 'disco.disco_files_publish',
          input: { files: [{ path: 'output/报告.pdf' }] },
          output: JSON.stringify({
            type: 'disco_file_publication',
            published: true,
            files: [
              {
                ref: 'upl_00000000-0000-4000-8000-000000000001',
                filename: '报告.pdf',
                mimeType: 'application/pdf',
                size: 12,
              },
            ],
          }),
          status: 'completed',
        },
      ],
    });

    expect(content[0]?.text).toBe('下载 [报告](output/报告.pdf)');
    expect(content[1]?.text).toContain('Attached files:');
    expect(content[1]?.text).toContain(
      '[报告.pdf](https://disco.live/_uploads/upl_00000000-0000-4000-8000-000000000001) (application/pdf, 12 B)'
    );
  });

  it('does not append a second attachment block for a structured file citation', () => {
    const ref = 'upl_00000000-0000-4000-8000-000000000001';
    const content = [{ type: 'file_citation' }];
    appendExplicitlyPublishedOutputs({
      content,
      excludedRefs: new Set([ref]),
      toolUses: [
        {
          id: 'publish-report',
          name: 'disco.disco_files_publish',
          input: { files: [{ path: 'output/报告.pdf' }] },
          output: JSON.stringify({
            type: 'disco_file_publication',
            published: true,
            files: [
              {
                ref,
                filename: '报告.pdf',
                mimeType: 'application/pdf',
                size: 12,
              },
            ],
          }),
          status: 'completed',
        },
      ],
    });

    expect(content).toEqual([{ type: 'file_citation' }]);
  });
});

// Track how many Codex instances were created (module-level state)
let mockInstanceCount = 0;
// Track options each constructed instance saw, in creation order. Lets
// tests assert that custom OPENAI_BASE_URL values and session config flow into
// Codex.Codex().
let mockInstanceBaseUrls: Array<string | undefined> = [];
let mockInstanceConfigs: Array<unknown> = [];
let mockClosedInstanceIds: number[] = [];
let mockStreamEvents: Array<Record<string, unknown>> = [];
let mockStartThreadId: string | undefined = 'mock-thread-id';
let mockStreamFailure: Error | undefined;
let mockStartThreadOptions: unknown[] = [];
let mockResumeThreadOptions: unknown[] = [];

async function* streamMockEvents() {
  for (const event of mockStreamEvents) {
    yield event;
  }
  if (mockStreamFailure) throw mockStreamFailure;
}

// Mock the Codex SDK to avoid spawning real Codex CLI processes
vi.mock('./app-server-client.js', () => appServerMocks);
vi.mock('@disco/core/mcp', async () => {
  const actual = await vi.importActual<typeof import('@disco/core/mcp')>('@disco/core/mcp');
  return { ...actual, ...mcpScopingMocks };
});
vi.mock('@disco/core/tools/mcp/jwt-auth', () => mcpAuthMocks);
vi.mock('../../config.js', () => configMocks);
vi.mock('../../commands/upload.js', () => uploadMocks);

vi.mock('@openai/codex-sdk', () => {
  class MockCodexClient {
    apiKey: string;
    baseUrl: string | undefined;
    instanceId: number;

    constructor(options: { apiKey?: string; baseUrl?: string; config?: unknown }) {
      this.apiKey = options.apiKey || '';
      this.baseUrl = options.baseUrl;
      this.instanceId = ++mockInstanceCount;
      mockInstanceBaseUrls.push(options.baseUrl);
      mockInstanceConfigs.push(options.config);
    }

    close() {
      mockClosedInstanceIds.push(this.instanceId);
    }

    startThread(options: unknown) {
      mockStartThreadOptions.push(options);
      return {
        id: mockStartThreadId,
        run: vi.fn(),
        runStreamed: vi.fn().mockResolvedValue({ events: streamMockEvents() }),
      };
    }

    resumeThread(threadId: string, options: unknown) {
      mockResumeThreadOptions.push(options);
      return {
        id: threadId,
        run: vi.fn(),
        runStreamed: vi.fn().mockResolvedValue({ events: streamMockEvents() }),
      };
    }
  }

  return { Codex: MockCodexClient };
});

// Mock repositories and database
const mockMessagesRepo = {} as any;
const mockSessionsRepo = {
  findById: vi.fn(),
  update: vi.fn(),
} as any;
const mockSessionMCPServerRepo = {
  listServers: vi.fn().mockResolvedValue([]),
  listServersWithMetadata: vi.fn().mockResolvedValue([]),
} as any;
const mockDb = {} as any;

describe('Codex per-session instruction assembly', () => {
  it('keeps standalone personality-free and Agent instructions concise without retired methods', async () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      'test-api-key',
      mockDb
    ) as unknown as {
      ensureCodexInstructionsFile: (
        sessionId: SessionID,
        options: {
          includeDiscoOrientation: boolean;
          userWorkspaceRoot?: string;
          agentRuntimeContext?: string;
          includeManagedLifecycle?: boolean;
          agentSession?: boolean;
        }
      ) => Promise<string>;
    };
    const userRoot = path.resolve('E:/Disco/data/disco/worktrees/user-reskip');
    const standalonePath = await service.ensureCodexInstructionsFile(
      'session-prompt-audit-standalone' as SessionID,
      {
        includeDiscoOrientation: false,
        includeManagedLifecycle: true,
        agentSession: false,
        userWorkspaceRoot: userRoot,
      }
    );
    const agentPath = await service.ensureCodexInstructionsFile(
      'session-prompt-audit-agent' as SessionID,
      {
        includeDiscoOrientation: true,
        includeManagedLifecycle: true,
        agentSession: true,
        userWorkspaceRoot: userRoot,
        agentRuntimeContext: '# 当前智能体资料\n\n## 身份\n\n家庭管家',
      }
    );

    try {
      const standalone = await fs.readFile(standalonePath, 'utf8');
      const agent = await fs.readFile(agentPath, 'utf8');

      expect(standalone).toContain('# Disco 用户目录边界');
      expect(standalone).toContain('默认目标是当前用户的 Disco 共享技能');
      expect(standalone).not.toContain('# Disco 智能体会话');
      expect(standalone).not.toContain('家庭管家');

      expect(agent).toContain('# Disco 智能体会话');
      expect(agent).toContain('默认目标是当前智能体');
      expect(agent).toContain('# 当前智能体资料');
      expect(agent).toContain('家庭管家');

      for (const text of [standalone, agent]) {
        expect(text).not.toContain('disco_upload_materialize');
        expect(text).not.toContain('等待后继续');
        expect(text).not.toContain('多步骤任务计划');
        expect(text).not.toContain('ACL');
        expect(text).not.toContain('Repo');
        expect(text).not.toContain('Branch');
        expect(text).not.toContain('Board');
        expect(text).not.toContain('Card');
        expect(text).not.toContain('Artifact');
      }
      expect(standalone.length).toBeLessThan(1_200);
      expect(agent.length).toBeLessThan(1_500);
    } finally {
      await Promise.all([
        fs.rm(standalonePath, { force: true }),
        fs.rm(agentPath, { force: true }),
      ]);
    }
  });
});

describe('CodexPromptService - uploaded turn input', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMocks.getDaemonUrl.mockResolvedValue('http://127.0.0.1:3030');
  });

  it('materializes uploads and sends images to Codex as local_image inputs', async () => {
    uploadMocks.materializeUploadToWorkspace.mockResolvedValue({
      path: '.disco/session-staging/session-1/upl_12345678-1234-4123-8123-123456789abc/photo.png',
      absolutePath:
        'E:\\workspace\\.disco\\session-staging\\session-1\\upl_12345678-1234-4123-8123-123456789abc\\photo.png',
    });
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      'test-api-key',
      mockDb,
      undefined,
      false,
      undefined,
      undefined,
      'executor-session-token'
    );
    const prompt = [
      'Attached files:',
      '- [photo.png](https://disco.live/_uploads/upl_12345678-1234-4123-8123-123456789abc) (image/png, 12.0 KiB)',
      '',
      '这张图里有什么？',
    ].join('\n');

    const input = await (service as any).buildTurnInput('session-1', prompt, 'E:\\workspace');

    expect(uploadMocks.materializeUploadToWorkspace).toHaveBeenCalledWith({
      daemonUrl: 'http://127.0.0.1:3030',
      sessionToken: 'executor-session-token',
      workspacePath: 'E:\\workspace',
      params: {
        sessionId: 'session-1',
        uploadRef: 'upl_12345678-1234-4123-8123-123456789abc',
        filename: 'photo.png',
      },
    });
    expect(input).toEqual([
      {
        type: 'text',
        text: expect.stringContaining(
          'photo.png: .disco/session-staging/session-1/upl_12345678-1234-4123-8123-123456789abc/photo.png (image/png)'
        ),
      },
      {
        type: 'local_image',
        path: 'E:\\workspace\\.disco\\session-staging\\session-1\\upl_12345678-1234-4123-8123-123456789abc\\photo.png',
      },
    ]);
  });
});

describe('CodexPromptService - command purpose metadata', () => {
  it('persists the server-side purpose on both command start and completion payloads', () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      'test-api-key'
    );
    const item = {
      id: 'command-purpose-1',
      type: 'command_execution',
      command: 'powershell.exe -Command "Get-Item sample.ncm"',
      aggregated_output: 'ok',
      status: 'completed',
    };
    const purpose = {
      label: '核对媒体文件信息',
      confidence: 0.91,
      source: 'model',
      needsModel: false,
    };

    const started = (service as any).itemToToolUse(item, 'started', purpose);
    const completed = (service as any).itemToToolUse(item, 'completed', purpose);

    expect(started.input).toMatchObject({
      title: '核对媒体文件信息',
      purposeSource: 'model',
      purposeConfidence: 0.91,
    });
    expect(completed.input).toEqual(started.input);
    expect(completed.output).toBe('ok');
  });
});

describe('CodexPromptService - SDK Instance Caching (issue #133)', () => {
  beforeEach(() => {
    mockInstanceCount = 0;
    mockInstanceBaseUrls = [];
    mockInstanceConfigs = [];
    mockClosedInstanceIds = [];
    mockStreamEvents = [];
    mockStartThreadId = 'mock-thread-id';
    mockStartThreadOptions = [];
    mockResumeThreadOptions = [];
    delete process.env.OPENAI_BASE_URL;
    vi.clearAllMocks();
    appServerMocks.forkCodexThreadViaAppServer.mockReset();
  });

  it('does not create a Codex instance on initialization before session MCP config is known', () => {
    const initialCount = mockInstanceCount;

    new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      'test-api-key',
      mockDb
    );

    expect(mockInstanceCount).toBe(initialCount);
  });

  it('should reuse the same Codex instance when API key and session config have not changed', async () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      'test-api-key',
      mockDb
    );

    const countAfterInit = mockInstanceCount;

    // Simulate multiple calls with the same API key and same per-session config
    // Access private methods via type assertion for testing
    const serviceWithPrivate = service as any;
    serviceWithPrivate.refreshClient('test-api-key');
    await serviceWithPrivate.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    serviceWithPrivate.refreshClient('test-api-key');
    await serviceWithPrivate.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    serviceWithPrivate.refreshClient('test-api-key');
    await serviceWithPrivate.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });

    // Should create only the lazily-initialized configured instance
    expect(mockInstanceCount).toBe(countAfterInit + 1);
  });

  it('should create a new Codex instance only when API key changes', async () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      'initial-key',
      mockDb
    );

    const countAfterInit = mockInstanceCount;

    const serviceWithPrivate = service as any;
    await serviceWithPrivate.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    expect(mockInstanceCount).toBe(countAfterInit + 1);

    // Call with same API key - should NOT create new instance
    serviceWithPrivate.refreshClient('initial-key');
    await serviceWithPrivate.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    expect(mockInstanceCount).toBe(countAfterInit + 1);

    // Call with different API key - next configured ensure SHOULD create new instance
    serviceWithPrivate.refreshClient('new-api-key');
    await serviceWithPrivate.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    expect(mockInstanceCount).toBe(countAfterInit + 2);
    expect(mockClosedInstanceIds).toContain(1);

    // Call with same new key again - should NOT create another instance
    serviceWithPrivate.refreshClient('new-api-key');
    await serviceWithPrivate.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    expect(mockInstanceCount).toBe(countAfterInit + 2);
  });

  it('should handle empty/undefined API keys correctly', async () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      undefined,
      mockDb
    );

    const countAfterInit = mockInstanceCount;

    // Call with empty string - should not instantiate if already empty and no
    // session config has been ensured yet.
    const serviceWithPrivate = service as any;
    serviceWithPrivate.refreshClient('');
    expect(mockInstanceCount).toBe(countAfterInit);

    await serviceWithPrivate.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    expect(mockInstanceCount).toBe(countAfterInit + 1);

    // Call with actual key - should create new instance on next ensure
    serviceWithPrivate.refreshClient('new-key');
    await serviceWithPrivate.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    expect(mockInstanceCount).toBe(countAfterInit + 2);
  });
});

describe('CodexPromptService - OPENAI_BASE_URL handling', () => {
  // These tests guard the per-user custom OpenAI-compatible endpoint surface.
  // The SDK takes baseUrl via its CodexOptions, so we assert the env var is
  // read, trimmed, propagated to Codex.Codex(), and treated as a refresh
  // signal independent of API-key changes.
  beforeEach(() => {
    mockInstanceCount = 0;
    mockInstanceBaseUrls = [];
    mockInstanceConfigs = [];
    mockClosedInstanceIds = [];
    delete process.env.OPENAI_BASE_URL;
    vi.clearAllMocks();
  });

  const makeService = (apiKey: string | undefined) =>
    new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      apiKey,
      mockDb
    );

  it('passes OPENAI_BASE_URL into Codex.Codex when session config is ensured', async () => {
    process.env.OPENAI_BASE_URL = 'https://gateway.example.com/v1';
    const service = makeService('test-api-key') as any;
    await service.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    expect(mockInstanceBaseUrls).toEqual(['https://gateway.example.com/v1']);
  });

  it('omits baseUrl when OPENAI_BASE_URL is unset', async () => {
    const service = makeService('test-api-key') as any;
    await service.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    expect(mockInstanceBaseUrls).toEqual([undefined]);
  });

  it('trims whitespace and treats whitespace-only as unset', async () => {
    process.env.OPENAI_BASE_URL = '   ';
    const service = makeService('test-api-key') as any;
    await service.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    expect(mockInstanceBaseUrls).toEqual([undefined]);
  });

  it('reinitializes Codex when OPENAI_BASE_URL changes between refreshes', async () => {
    const service = makeService('stable-key') as any;
    const countAfterInit = mockInstanceCount;
    await service.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    expect(mockInstanceCount).toBe(countAfterInit + 1);

    // Same key, base URL appears -> next ensure must recreate.
    process.env.OPENAI_BASE_URL = 'https://gateway.example.com/v1';
    service.refreshClient('stable-key');
    await service.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    expect(mockInstanceCount).toBe(countAfterInit + 2);
    expect(mockInstanceBaseUrls.at(-1)).toBe('https://gateway.example.com/v1');

    // Same key, same URL -> must NOT recreate (issue #133 protection).
    service.refreshClient('stable-key');
    await service.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    expect(mockInstanceCount).toBe(countAfterInit + 2);

    // Same key, URL cleared -> must recreate without baseUrl.
    delete process.env.OPENAI_BASE_URL;
    service.refreshClient('stable-key');
    await service.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    expect(mockInstanceCount).toBe(countAfterInit + 3);
    expect(mockInstanceBaseUrls.at(-1)).toBeUndefined();
  });
});

describe('CodexPromptService - prompt flow client initialization', () => {
  beforeEach(() => {
    mockInstanceCount = 0;
    mockInstanceBaseUrls = [];
    mockInstanceConfigs = [];
    mockClosedInstanceIds = [];
    mockStreamEvents = [];
    mockStartThreadOptions = [];
    mockResumeThreadOptions = [];
    delete process.env.OPENAI_BASE_URL;
    delete process.env.DISCO_CODEX_SANDBOX_MODE;
    vi.clearAllMocks();
  });

  it.each([
    {
      name: 'persisted allow-all',
      persistedPermissionMode: 'allow-all',
      codexPermissions: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        networkAccess: true,
      },
      expectedApps: {
        _default: {
          default_tools_approval_mode: 'approve',
        },
      },
    },
    {
      name: 'prompt allow-all overriding persisted auto',
      persistedPermissionMode: 'auto',
      promptPermissionMode: 'allow-all',
      codexPermissions: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        networkAccess: true,
      },
      expectedApps: {
        _default: {
          default_tools_approval_mode: 'approve',
        },
      },
    },
    {
      name: 'prompt auto overriding persisted allow-all',
      persistedPermissionMode: 'allow-all',
      promptPermissionMode: 'auto',
      codexPermissions: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        networkAccess: true,
      },
      expectedApps: undefined,
    },
    {
      name: 'mode-less legacy session using the Codex system default',
      persistedPermissionMode: undefined,
      codexPermissions: {},
      expectedApps: {
        _default: {
          default_tools_approval_mode: 'approve',
        },
      },
    },
    {
      name: 'allow-all with the k8s sandbox override',
      persistedPermissionMode: 'allow-all',
      codexPermissions: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        networkAccess: true,
      },
      sandboxModeEnvOverride: 'danger-full-access',
      expectedApps: {
        _default: {
          default_tools_approval_mode: 'approve',
        },
      },
    },
    {
      name: 'allow-all with a read-only sandbox environment override',
      persistedPermissionMode: 'allow-all',
      codexPermissions: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        networkAccess: true,
      },
      sandboxModeEnvOverride: 'read-only',
      expectedApps: undefined,
    },
    {
      name: 'allow-all with network disabled',
      persistedPermissionMode: 'allow-all',
      codexPermissions: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        networkAccess: false,
      },
      expectedApps: undefined,
    },
    {
      name: 'allow-all with approval required',
      persistedPermissionMode: 'allow-all',
      codexPermissions: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        networkAccess: true,
      },
      expectedApps: undefined,
    },
    {
      name: 'allow-all with a configured read-only sandbox',
      persistedPermissionMode: 'allow-all',
      codexPermissions: {
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        networkAccess: true,
      },
      expectedApps: undefined,
    },
    {
      name: 'persisted auto mode with never approval',
      persistedPermissionMode: 'auto',
      codexPermissions: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        networkAccess: true,
      },
      expectedApps: undefined,
    },
  ])(
    'builds session config for $name permissions and uses the configured accessor',
    async ({
      persistedPermissionMode,
      promptPermissionMode,
      codexPermissions,
      sandboxModeEnvOverride,
      expectedApps,
    }) => {
      if (sandboxModeEnvOverride) {
        process.env.DISCO_CODEX_SANDBOX_MODE = sandboxModeEnvOverride;
      }

      const service = new CodexPromptService(
        mockMessagesRepo,
        mockSessionsRepo,
        mockSessionMCPServerRepo,
        'test-api-key',
        mockDb
      );

      const serviceWithPrivates = service as any;
      serviceWithPrivates.ensureCodexInstructionsFile = vi
        .fn()
        .mockResolvedValue('/tmp/disco-codex-instructions-flow.md');
      serviceWithPrivates.buildMcpServersConfig = vi.fn().mockResolvedValue({
        total: 1,
        servers: {
          disco: {
            url: 'http://localhost:3030/mcp',
            default_tools_approval_mode: 'approve',
          },
        },
      });

      mockSessionsRepo.findById.mockResolvedValue({
        session_id: 'session-flow',
        working_directory: TEST_WORKING_DIRECTORY,
        created_at: new Date().toISOString(),
        sdk_session_id: null,
        permission_config: {
          ...(persistedPermissionMode ? { mode: persistedPermissionMode } : {}),
          codex: codexPermissions,
        },
        model_config: { effort: 'medium', serviceTier: 'fast' },
        mcp_token: 'test-token',
      });
      mockSessionsRepo.update.mockResolvedValue(undefined);

      mockStreamEvents = [
        {
          type: 'turn.completed',
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
        },
      ];

      const emitted: Array<Record<string, unknown>> = [];
      for await (const event of service.promptSessionStreaming(
        'session-flow' as any,
        'review',
        undefined,
        promptPermissionMode as PermissionMode | undefined
      )) {
        emitted.push(event as Record<string, unknown>);
      }

      expect(mockInstanceCount).toBe(1);
      expect(mockInstanceConfigs).toMatchObject([
        {
          features: { goals: false },
          model_instructions_file: '/tmp/disco-codex-instructions-flow.md',
          service_tier: 'fast',
          mcp_servers: {
            disco: {
              url: 'http://localhost:3030/mcp',
              default_tools_approval_mode: 'approve',
            },
          },
          ...(expectedApps ? { apps: expectedApps } : {}),
        },
      ]);
      expect(emitted.find((event) => event.type === 'complete')).toMatchObject({
        threadId: 'mock-thread-id',
      });
      expect(mockStartThreadOptions.at(-1)).toMatchObject({
        modelReasoningEffort: 'medium',
      });
    }
  );

  it('requires MCP startup from gateway session metadata in the prompt path', async () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      'test-api-key',
      mockDb
    );

    const serviceWithPrivates = service as any;
    serviceWithPrivates.ensureCodexInstructionsFile = vi
      .fn()
      .mockResolvedValue('/tmp/disco-codex-instructions-gateway.md');

    configMocks.getDaemonUrl.mockResolvedValue('http://localhost:3030');
    mcpScopingMocks.getMcpServersForSession.mockResolvedValue([
      {
        server: {
          name: 'remote',
          transport: 'http',
          url: 'https://example.com/mcp',
        },
      },
    ]);

    mockSessionsRepo.findById.mockResolvedValue({
      session_id: 'session-gateway',
      working_directory: TEST_WORKING_DIRECTORY,
      created_at: new Date().toISOString(),
      sdk_session_id: null,
      permission_config: { codex: {} },
      model_config: {},
      mcp_token: 'test-token',
      custom_context: { gateway_source: { channel_id: 'channel-1' } },
    });
    mockSessionsRepo.update.mockResolvedValue(undefined);

    mockStreamEvents = [
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
    ];

    for await (const _event of service.promptSessionStreaming('session-gateway' as any, 'review')) {
      // Drain stream to force client setup.
    }

    expect(mockInstanceConfigs.at(-1)).toMatchObject({
      model_instructions_file: '/tmp/disco-codex-instructions-gateway.md',
      mcp_servers: {
        disco: {
          url: 'http://localhost:3030/mcp',
          default_tools_approval_mode: 'approve',
        },
        remote: {
          url: 'https://example.com/mcp',
          default_tools_approval_mode: 'approve',
        },
      },
    });
  });

  it('gives standalone chats a per-session writable directory without agent personality', async () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      'test-api-key',
      mockDb
    );

    const serviceWithPrivates = service as any;
    serviceWithPrivates.ensureCodexInstructionsFile = vi
      .fn()
      .mockResolvedValue('/tmp/should-not-be-created.md');
    serviceWithPrivates.buildMcpServersConfig = vi.fn().mockResolvedValue({
      total: 1,
      servers: {
        user_search: {
          url: 'https://example.com/mcp',
          default_tools_approval_mode: 'approve',
        },
      },
    });

    mockSessionsRepo.update.mockResolvedValue(undefined);
    const userRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'user-test-'));
    const standaloneRoot = path.join(userRoot, 'standalone');
    const standaloneSessionRoot = path.join(standaloneRoot, 'session-standalone');
    mockSessionsRepo.findById.mockResolvedValue({
      session_id: 'session-standalone',
      working_directory: standaloneSessionRoot,
      agent_id: null,
      created_at: new Date().toISOString(),
      created_by: 'user-1',
      sdk_session_id: null,
      permission_config: { codex: {} },
      model_config: {},
      mcp_token: 'disco-session-token',
    });
    mockStreamEvents = [
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
    ];

    for await (const _event of service.promptSessionStreaming(
      'session-standalone' as any,
      'test'
    )) {
      // Drain the stream to force client setup.
    }

    expect(serviceWithPrivates.ensureCodexInstructionsFile).toHaveBeenCalledWith(
      'session-standalone',
      {
        agentSession: false,
        includeDiscoOrientation: false,
        includeManagedLifecycle: true,
        userWorkspaceRoot: userRoot,
      }
    );
    expect(serviceWithPrivates.buildMcpServersConfig).toHaveBeenCalledWith(
      'session-standalone',
      'disco-session-token',
      {
        forUserId: 'user-1',
        sessionOwnerId: 'user-1',
      }
    );
    expect(mockInstanceConfigs.at(-1)).toMatchObject({
      features: {
        goals: false,
        request_permissions_tool: false,
        exec_permission_approvals: false,
      },
      include_permissions_instructions: false,
      project_doc_max_bytes: 0,
      model_instructions_file: '/tmp/should-not-be-created.md',
      service_tier: 'default',
      mcp_servers: {
        user_search: {
          url: 'https://example.com/mcp',
          default_tools_approval_mode: 'approve',
        },
      },
      apps: { _default: { default_tools_approval_mode: 'approve' } },
    });
    expect(mockStartThreadOptions.at(-1)).toMatchObject({
      workingDirectory: standaloneSessionRoot,
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
      skipGitRepoCheck: true,
    });
    expect(mockStartThreadOptions.at(-1)).not.toHaveProperty('additionalDirectories');
    await fs.rm(userRoot, { recursive: true, force: true });
  });

  it('injects a preloaded canonical agent context for a nested agent session', async () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      'test-api-key',
      mockDb
    );
    const serviceWithPrivates = service as any;
    serviceWithPrivates.ensureCodexInstructionsFile = vi
      .fn()
      .mockResolvedValue('/tmp/disco-agent-runtime-instructions.md');
    serviceWithPrivates.buildMcpServersConfig = vi.fn().mockResolvedValue({
      total: 0,
      servers: {},
    });

    const userRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'user-agent-runtime-'));
    const agentRoot = path.join(userRoot, 'agents', 'family-helper');
    const agentSessionRoot = path.join(agentRoot, 'sessions', 'session-agent-runtime');
    await fs.mkdir(path.join(agentRoot, '.disco'), { recursive: true });
    await fs.writeFile(
      path.join(agentRoot, '.disco', 'agent.json'),
      `${JSON.stringify(
        createDefaultDiscoAgentProfile({
          displayName: '家庭管家',
          responsibilities: '维护家庭设备并记住长期约定。',
        }),
        null,
        2
      )}\n`,
      'utf8'
    );
    serviceWithPrivates.agentsRepo = {
      findById: vi.fn().mockResolvedValue({
        agent_id: 'agent-family-helper',
        created_by: 'user-1',
        display_name: '家庭管家',
        description: '维护家庭设备并记住长期约定。',
        workspace_path: agentRoot,
        state: 'ready',
        archived: false,
      }),
    };
    mockSessionsRepo.findById.mockResolvedValue({
      session_id: 'session-agent-runtime',
      agent_id: 'agent-family-helper',
      working_directory: agentSessionRoot,
      created_at: new Date().toISOString(),
      created_by: 'user-1',
      sdk_session_id: null,
      permission_config: { codex: {} },
      model_config: {},
    });
    mockSessionsRepo.update.mockResolvedValue(undefined);
    mockStreamEvents = [
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
    ];

    try {
      for await (const _event of service.promptSessionStreaming(
        'session-agent-runtime' as any,
        '你是谁'
      )) {
        // Drain the stream to force context preparation.
      }

      expect(serviceWithPrivates.ensureCodexInstructionsFile).toHaveBeenCalledWith(
        'session-agent-runtime',
        expect.objectContaining({
          includeDiscoOrientation: true,
          userWorkspaceRoot: userRoot,
          agentRuntimeContext: expect.stringContaining('家庭管家'),
        })
      );
      expect(
        serviceWithPrivates.ensureCodexInstructionsFile.mock.calls[0][1]
          .agentRuntimeContext as string
      ).toContain('维护家庭设备并记住长期约定');
      expect(mockInstanceConfigs.at(-1)).toMatchObject({
        project_doc_max_bytes: 0,
        model_instructions_file: '/tmp/disco-agent-runtime-instructions.md',
      });
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(
              agentRoot,
              'sessions',
              'session-agent-runtime',
              '.disco-runtime',
              'preload.json'
            ),
            'utf8'
          )
        )
      ).toMatchObject({ status: 'ready', memory_files: 0 });
    } finally {
      await fs.rm(userRoot, { recursive: true, force: true });
    }
  });

  it('owns fresh Codex thread state after clearing a stale thread for new MCP config', async () => {
    const sessionId = 'session-fresh-thread' as SessionID;
    const sessionCreatedAt = new Date('2026-01-01T00:00:00.000Z');
    let storedSdkSessionId: string | undefined = 'stale-thread-id';
    const sessionsRepo = {
      findById: vi.fn(async (_sessionId: SessionID) => ({
        session_id: sessionId,
        working_directory: TEST_WORKING_DIRECTORY,
        created_at: sessionCreatedAt.toISOString(),
        last_updated: sessionCreatedAt.toISOString(),
        sdk_session_id: storedSdkSessionId,
        permission_config: { codex: {} },
        model_config: {},
      })),
      update: vi.fn(async (_sessionId: SessionID, patch: SessionUpdate) => {
        if (patch.sdk_session_id === null) storedSdkSessionId = undefined;
        else if (patch.sdk_session_id !== undefined) storedSdkSessionId = patch.sdk_session_id;
        return { sdk_session_id: storedSdkSessionId };
      }),
    };
    const messagesRepo = {
      findInitialUserMessagesByTaskId: vi.fn(async () => []),
      getNextIndexBySessionId: vi.fn(async (_sessionId: SessionID) => 0),
    };
    const sessionMCPServerRepo = {
      listServersWithMetadata: vi.fn(async (_sessionId: SessionID, _enabledOnly = false) => [
        {
          server: { name: 'new-server' },
          added_at: sessionCreatedAt.getTime() + 60_000,
          enabled: true,
        },
      ]),
    };
    const messagesService = {
      create: vi.fn(async (message: Partial<Message>) => message as Message),
      patch: vi.fn(async (_messageId: string, message: Partial<Message>) => message as Message),
    } satisfies MessagesService;
    const tool = new CodexTool(
      messagesRepo as unknown as MessagesRepository,
      sessionsRepo as unknown as SessionRepository,
      sessionMCPServerRepo as unknown as SessionMCPServerRepository,
      'test-api-key',
      messagesService
    );
    const previousStreamEvents = mockStreamEvents;
    const previousStartThreadId = mockStartThreadId;
    const previousStreamFailure = mockStreamFailure;
    mockStartThreadId = 'fresh-thread-id';
    mockStreamFailure = undefined;
    mockStreamEvents = [
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
    ];

    try {
      await mcpScopingMocks.getMcpServersForSession.withImplementation(
        vi.fn().mockResolvedValue([]),
        async () => {
          await expect(
            tool.executePromptWithStreaming(sessionId, 'continue')
          ).resolves.toBeDefined();

          expect(sessionsRepo.update).toHaveBeenNthCalledWith(1, sessionId, {
            sdk_session_id: null,
          });
          expect(sessionsRepo.update).toHaveBeenNthCalledWith(2, sessionId, {
            sdk_session_id: 'fresh-thread-id',
          });
          expect(storedSdkSessionId).toBe('fresh-thread-id');

          storedSdkSessionId = 'stale-thread-id';
          sessionsRepo.update.mockClear();
          mockStreamEvents = [
            {
              type: 'item.completed',
              item: { id: 'message-1', type: 'agent_message', text: 'Progress.' },
            },
          ];
          mockStreamFailure = new Error('event iterator failed after thread capture');

          await expect(tool.executePromptWithStreaming(sessionId, 'continue')).rejects.toThrow(
            'event iterator failed after thread capture'
          );
        }
      );

      expect(sessionsRepo.update).toHaveBeenNthCalledWith(1, sessionId, {
        sdk_session_id: null,
      });
      expect(sessionsRepo.update).toHaveBeenNthCalledWith(2, sessionId, {
        sdk_session_id: 'fresh-thread-id',
      });
      expect(sessionsRepo.update).toHaveBeenNthCalledWith(3, sessionId, {
        sdk_session_id: null,
      });
      expect(storedSdkSessionId).toBeUndefined();
    } finally {
      mockStreamEvents = previousStreamEvents;
      mockStartThreadId = previousStartThreadId;
      mockStreamFailure = previousStreamFailure;
      await fs.rm(path.join(os.tmpdir(), 'disco-codex-instructions-session-fresh-thread.md'), {
        force: true,
      });
    }
  });
});

describe('CodexPromptService - forked sessions', () => {
  beforeEach(() => {
    mockInstanceCount = 0;
    mockInstanceBaseUrls = [];
    mockInstanceConfigs = [];
    mockClosedInstanceIds = [];
    mockStreamEvents = [];
    mockStartThreadOptions = [];
    mockResumeThreadOptions = [];
    delete process.env.OPENAI_BASE_URL;
    vi.clearAllMocks();
    appServerMocks.forkCodexThreadViaAppServer.mockReset();
  });

  it('forks the parent Codex thread via app-server before resuming the child thread', async () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      'test-api-key',
      mockDb
    );

    const serviceWithPrivates = service as any;
    serviceWithPrivates.ensureCodexInstructionsFile = vi
      .fn()
      .mockResolvedValue('/tmp/disco-codex-instructions-child.md');
    serviceWithPrivates.buildMcpServersConfig = vi
      .fn()
      .mockResolvedValue({ servers: {}, total: 0 });
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/disco-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    const childSession = {
      session_id: 'child-session',
      working_directory: TEST_WORKING_DIRECTORY,
      created_at: new Date().toISOString(),
      sdk_session_id: null,
      genealogy: { forked_from_session_id: 'parent-session' },
      permission_config: { codex: {} },
      model_config: { effort: 'max' },
      mcp_token: 'test-token',
    };
    const parentSession = {
      session_id: 'parent-session',
      working_directory: TEST_WORKING_DIRECTORY,
      created_at: new Date().toISOString(),
      sdk_session_id: 'parent-thread-id',
      permission_config: { codex: {} },
      model_config: {},
      mcp_token: 'test-token',
    };

    mockSessionsRepo.findById.mockImplementation(async (id: string) => {
      if (id === 'child-session') return childSession;
      if (id === 'parent-session') return parentSession;
      return null;
    });
    mockSessionsRepo.update.mockResolvedValue(undefined);
    appServerMocks.forkCodexThreadViaAppServer.mockResolvedValue('forked-thread-id');

    mockStreamEvents = [
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
    ];

    const emitted: Array<Record<string, unknown>> = [];
    for await (const event of service.promptSessionStreaming('child-session' as any, 'continue')) {
      emitted.push(event as Record<string, unknown>);
    }

    expect(appServerMocks.forkCodexThreadViaAppServer).toHaveBeenCalledWith(
      'parent-thread-id',
      expect.objectContaining({ env: expect.any(Object) })
    );
    expect(mockSessionsRepo.update).toHaveBeenCalledWith('child-session', {
      sdk_session_id: 'forked-thread-id',
    });
    expect(emitted.find((event) => event.type === 'complete')).toMatchObject({
      threadId: 'forked-thread-id',
    });
    expect(mockResumeThreadOptions.at(-1)).toMatchObject({
      modelReasoningEffort: 'max',
    });
  });
});

describe('CodexPromptService - Todo normalization', () => {
  it('maps codex todo_list to TodoWrite-compatible payload with inferred in_progress', () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      'test-api-key',
      mockDb
    );

    const toolUse = (service as any).itemToToolUse(
      {
        id: 'todo-1',
        type: 'todo_list',
        items: [
          { text: 'Completed step', completed: true },
          { text: 'Current step', completed: false },
          { text: 'Next step', completed: false },
        ],
      },
      'completed'
    );

    expect(toolUse).toEqual({
      id: 'todo-1',
      name: 'TodoWrite',
      input: {
        todos: [
          {
            content: 'Completed step',
            activeForm: 'Completed step',
            status: 'completed',
          },
          {
            content: 'Current step',
            activeForm: 'Current step',
            status: 'in_progress',
          },
          {
            content: 'Next step',
            activeForm: 'Next step',
            status: 'pending',
          },
        ],
      },
    });
  });

  it('returns null for empty todo_list', () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      'test-api-key',
      mockDb
    );

    const toolUse = (service as any).itemToToolUse(
      {
        id: 'todo-empty',
        type: 'todo_list',
        items: [],
      },
      'completed'
    );

    expect(toolUse).toBeNull();
  });

  it('emits only one TodoWrite tool_complete when both item.updated and item.completed fire', async () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      'test-api-key',
      mockDb
    );

    // Avoid filesystem/config setup noise in this focused stream test
    const serviceWithPrivates = service as any;
    serviceWithPrivates.ensureCodexInstructionsFile = vi
      .fn()
      .mockResolvedValue('/tmp/disco-codex-instructions-mock.md');
    serviceWithPrivates.buildMcpServersConfig = vi
      .fn()
      .mockResolvedValue({ servers: {}, total: 0 });
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/disco-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    mockSessionsRepo.findById.mockResolvedValue({
      session_id: 'session-1',
      working_directory: TEST_WORKING_DIRECTORY,
      created_at: new Date().toISOString(),
      sdk_session_id: null,
      permission_config: { codex: {} },
      model_config: {},
      mcp_token: 'test-token',
    });

    mockStreamEvents = [
      { type: 'turn.started' },
      {
        type: 'item.updated',
        item: {
          id: 'todo-1',
          type: 'todo_list',
          items: [{ text: 'Review API client changes', completed: false }],
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'todo-1',
          type: 'todo_list',
          items: [{ text: 'Review API client changes', completed: false }],
        },
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 10,
          cached_input_tokens: 0,
          output_tokens: 20,
        },
      },
    ];

    const emitted: Array<{ type: string; toolUse?: { name?: string } }> = [];
    for await (const event of service.promptSessionStreaming('session-1' as any, 'review')) {
      emitted.push(event as { type: string; toolUse?: { name?: string } });
    }

    const todoCompletions = emitted.filter(
      (event) => event.type === 'tool_complete' && event.toolUse?.name === 'TodoWrite'
    );
    expect(todoCompletions).toHaveLength(1);
  });
});

describe('CodexPromptService - tool payload mapping', () => {
  it('captures token_count context snapshot and forwards it on turn completion', async () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      'test-api-key',
      mockDb
    );

    const serviceWithPrivates = service as any;
    serviceWithPrivates.ensureCodexInstructionsFile = vi
      .fn()
      .mockResolvedValue('/tmp/disco-codex-instructions-mock.md');
    serviceWithPrivates.buildMcpServersConfig = vi
      .fn()
      .mockResolvedValue({ servers: {}, total: 0 });
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/disco-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    mockSessionsRepo.findById.mockResolvedValue({
      session_id: 'session-ctx',
      working_directory: TEST_WORKING_DIRECTORY,
      created_at: new Date().toISOString(),
      sdk_session_id: null,
      permission_config: { codex: {} },
      model_config: {},
      mcp_token: 'test-token',
    });

    mockStreamEvents = [
      { type: 'turn.started' },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              total_tokens: 210000,
            },
            last_token_usage: {
              total_tokens: 12000,
            },
            model_context_window: 272000,
          },
        },
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 1000,
          cached_input_tokens: 500,
          output_tokens: 300,
        },
      },
    ];

    const emitted: Array<Record<string, unknown>> = [];
    for await (const event of service.promptSessionStreaming('session-ctx' as any, 'review')) {
      emitted.push(event as Record<string, unknown>);
    }

    const completeEvent = emitted.find((event) => event.type === 'complete');
    const usageSnapshot = emitted.find((event) => event.type === 'usage_snapshot');
    expect(usageSnapshot).toMatchObject({
      usage: { total_tokens: 12_000 },
      rawContextUsage: { totalTokens: 12_000, maxTokens: 272_000, percentage: 0 },
    });
    expect(completeEvent).toBeTruthy();
    // Snapshot must use last_token_usage (current occupancy = 12_000), NOT
    // total_token_usage (lifetime cumulative = 210_000). Percentage applies
    // Codex CLI's baseline subtraction (12_000 baseline on a 272_000 window):
    // used = max(0, 12_000 - 12_000) = 0  →  0% used.
    expect(completeEvent?.rawContextUsage).toEqual({
      totalTokens: 12000,
      maxTokens: 272000,
      percentage: 0,
    });
  });

  it('falls back to Codex rollout JSONL token_count when SDK stream omits event_msg', async () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      'test-api-key',
      mockDb
    );

    const serviceWithPrivates = service as any;
    serviceWithPrivates.ensureCodexInstructionsFile = vi
      .fn()
      .mockResolvedValue('/tmp/disco-codex-instructions-mock.md');
    serviceWithPrivates.buildMcpServersConfig = vi
      .fn()
      .mockResolvedValue({ servers: {}, total: 0 });
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/disco-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    mockSessionsRepo.findById.mockResolvedValue({
      session_id: 'session-rollout-ctx',
      working_directory: TEST_WORKING_DIRECTORY,
      created_at: new Date().toISOString(),
      sdk_session_id: null,
      permission_config: { codex: {} },
      model_config: {},
      mcp_token: 'test-token',
    });

    const previousCodexHome = process.env.CODEX_HOME;
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'disco-codex-home-'));
    process.env.CODEX_HOME = codexHome;
    try {
      const rolloutDir = path.join(codexHome, 'sessions', '2026', '06', '24');
      await fs.mkdir(rolloutDir, { recursive: true });
      await fs.writeFile(
        path.join(rolloutDir, 'rollout-2026-06-24T00-00-00-mock-thread-id.jsonl'),
        `${JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: { total_tokens: 187_135 },
              last_token_usage: { total_tokens: 26_612 },
              model_context_window: 258_400,
            },
          },
        })}
`,
        'utf8'
      );

      mockStreamEvents = [
        { type: 'turn.started' },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 184_792,
            cached_input_tokens: 162_688,
            output_tokens: 2_343,
          },
        },
      ];

      const emitted: Array<Record<string, unknown>> = [];
      for await (const event of service.promptSessionStreaming(
        'session-rollout-ctx' as any,
        'review'
      )) {
        emitted.push(event as Record<string, unknown>);
      }

      const completeEvent = emitted.find((event) => event.type === 'complete');
      expect(completeEvent?.rawContextUsage).toEqual({
        totalTokens: 26_612,
        maxTokens: 258_400,
        percentage: 6,
      });
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      await fs.rm(codexHome, { recursive: true, force: true });
    }
  });

  it('does not scan rollout JSONL files when the SDK thread id is missing', async () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      'test-api-key',
      mockDb
    );

    const serviceWithPrivates = service as any;
    serviceWithPrivates.ensureCodexInstructionsFile = vi
      .fn()
      .mockResolvedValue('/tmp/disco-codex-instructions-mock.md');
    serviceWithPrivates.buildMcpServersConfig = vi
      .fn()
      .mockResolvedValue({ servers: {}, total: 0 });
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/disco-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    mockSessionsRepo.findById.mockResolvedValue({
      session_id: 'session-rollout-missing-thread',
      working_directory: TEST_WORKING_DIRECTORY,
      created_at: new Date().toISOString(),
      sdk_session_id: null,
      permission_config: { codex: {} },
      model_config: {},
      mcp_token: 'test-token',
    });

    const previousCodexHome = process.env.CODEX_HOME;
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'disco-codex-home-'));
    mockStartThreadId = undefined;
    process.env.CODEX_HOME = codexHome;
    try {
      const rolloutDir = path.join(codexHome, 'sessions', '2026', '06', '24');
      await fs.mkdir(rolloutDir, { recursive: true });
      await fs.writeFile(
        path.join(rolloutDir, 'rollout-2026-06-24T00-00-00-unrelated-thread.jsonl'),
        `${JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { total_tokens: 99_999 },
              model_context_window: 258_400,
            },
          },
        })}
`,
        'utf8'
      );

      mockStreamEvents = [
        { type: 'turn.started' },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 1_000,
            cached_input_tokens: 500,
            output_tokens: 300,
          },
        },
      ];

      const emitted: Array<Record<string, unknown>> = [];
      for await (const event of service.promptSessionStreaming(
        'session-rollout-missing-thread' as any,
        'review'
      )) {
        emitted.push(event as Record<string, unknown>);
      }

      const completeEvent = emitted.find((event) => event.type === 'complete');
      expect(completeEvent?.rawContextUsage).toBeUndefined();
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      await fs.rm(codexHome, { recursive: true, force: true });
    }
  });

  it('preserves MCP result content on completion', () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      'test-api-key',
      mockDb
    );

    const toolUse = (service as any).itemToToolUse(
      {
        id: 'mcp-1',
        type: 'mcp_tool_call',
        server: 'disco',
        tool: 'disco_execute_tool',
        arguments: { tool_name: 'disco_branches_list' },
        result: {
          content: [{ type: 'text', text: 'ok' }],
          structured_content: { success: true },
        },
        status: 'completed',
      },
      'completed'
    );

    expect(toolUse).toEqual({
      id: 'mcp-1',
      name: 'disco.disco_execute_tool',
      input: { tool_name: 'disco_branches_list' },
      output: [{ type: 'text', text: 'ok' }],
      status: 'completed',
    });
  });

  it('preserves MCP error message on failure', () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      'test-api-key',
      mockDb
    );

    const toolUse = (service as any).itemToToolUse(
      {
        id: 'mcp-2',
        type: 'mcp_tool_call',
        server: 'disco',
        tool: 'disco_execute_tool',
        arguments: {},
        error: {
          message: 'permission denied',
        },
        status: 'failed',
      },
      'completed'
    );

    expect(toolUse).toEqual({
      id: 'mcp-2',
      name: 'disco.disco_execute_tool',
      input: {},
      output: 'permission denied',
      status: 'failed',
    });
  });

  it('falls back to structured_content when MCP content blocks are empty', () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      'test-api-key',
      mockDb
    );

    const toolUse = (service as any).itemToToolUse(
      {
        id: 'mcp-structured-only',
        type: 'mcp_tool_call',
        server: 'disco',
        tool: 'disco_execute_tool',
        arguments: { tool_name: 'disco_sessions_get_current' },
        result: {
          content: [],
          structured_content: { session_id: 'abc123', status: 'running' },
        },
        status: 'completed',
      },
      'completed'
    );

    expect(toolUse).toEqual({
      id: 'mcp-structured-only',
      name: 'disco.disco_execute_tool',
      input: { tool_name: 'disco_sessions_get_current' },
      output: JSON.stringify({ session_id: 'abc123', status: 'running' }, null, 2),
      status: 'completed',
    });
  });

  it('marks web_search as completed to avoid stale UI status', () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      'test-api-key',
      mockDb
    );

    const toolUse = (service as any).itemToToolUse(
      {
        id: 'search-1',
        type: 'web_search',
        query: 'openai codex sdk',
      },
      'completed'
    );

    expect(toolUse).toEqual({
      id: 'search-1',
      name: 'web_search',
      input: { query: 'openai codex sdk' },
      status: 'completed',
    });
  });

  it('clears resume state on a fatal stream error even when the session started fresh', async () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      'test-api-key',
      mockDb
    );

    const serviceWithPrivates = service as any;
    serviceWithPrivates.ensureCodexInstructionsFile = vi
      .fn()
      .mockResolvedValue('/tmp/disco-codex-instructions-mock.md');
    serviceWithPrivates.buildMcpServersConfig = vi
      .fn()
      .mockResolvedValue({ servers: {}, total: 0 });
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/disco-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    mockSessionsRepo.findById.mockResolvedValue({
      session_id: 'session-1',
      working_directory: TEST_WORKING_DIRECTORY,
      created_at: new Date().toISOString(),
      sdk_session_id: null,
      permission_config: { codex: {} },
      model_config: {},
      mcp_token: 'test-token',
    });

    mockStreamEvents = [{ type: 'error', message: 'stream exploded' }];

    await expect(
      (async () => {
        for await (const _event of service.promptSessionStreaming('session-1' as any, 'review')) {
          // no-op
        }
      })()
    ).rejects.toThrow('Codex stream error: stream exploded');

    expect(mockSessionsRepo.update).toHaveBeenCalledWith('session-1', {
      sdk_session_id: null,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// event_msg terminal handling (issue #1749)
//
// New Codex rollout format emits terminal completion via `event_msg` payloads
// with payload.type === "agent_message" or "task_complete" instead of the SDK
// event turn.completed. Without handling these, the adapter left the task
// running until the daemon safety-net (~15 min later) marked it failed.
// ─────────────────────────────────────────────────────────────────────────────
describe('CodexPromptService - event_msg terminal handling (issue #1749)', () => {
  type CodexPromptServiceTestHarness = CodexPromptService & {
    ensureCodexClient(config: { model_instructions_file: string }): Promise<void>;
    refreshClient(apiKey: string): void;
    codex: {
      startThread: (...args: never[]) => unknown;
      resumeThread: (...args: never[]) => unknown;
    };
  };

  const testSessionId = 'session-1' as SessionID;

  function makeStreamingService(sdkSessionId: string | null = null) {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      'test-api-key',
      mockDb
    );

    const serviceWithPrivates = service as any;
    serviceWithPrivates.ensureCodexInstructionsFile = vi
      .fn()
      .mockResolvedValue('/tmp/disco-codex-instructions-mock.md');
    serviceWithPrivates.buildMcpServersConfig = vi
      .fn()
      .mockResolvedValue({ servers: {}, total: 0 });

    mockSessionsRepo.findById.mockResolvedValue({
      session_id: 'session-1',
      working_directory: TEST_WORKING_DIRECTORY,
      created_at: new Date().toISOString(),
      sdk_session_id: sdkSessionId,
      permission_config: { codex: {} },
      model_config: {},
      mcp_token: 'test-token',
    });

    return service;
  }

  async function makeInitializedStreamingService(sdkSessionId: string | null = null) {
    const service = makeStreamingService(sdkSessionId);
    const internals = service as unknown as CodexPromptServiceTestHarness;
    await internals.ensureCodexClient({
      model_instructions_file: '/tmp/disco-codex-instructions-mock.md',
    });
    internals.ensureCodexClient = vi.fn(async () => {});
    internals.refreshClient = vi.fn();
    return { service, codex: internals.codex };
  }

  async function drain(service: CodexPromptService, abortController?: AbortController) {
    const emitted: Array<Record<string, unknown>> = [];
    for await (const event of service.promptSessionStreaming(
      testSessionId,
      'go',
      undefined,
      undefined,
      abortController
    )) {
      emitted.push(event as Record<string, unknown>);
    }
    return emitted;
  }

  beforeEach(() => {
    mockInstanceCount = 0;
    mockInstanceBaseUrls = [];
    mockInstanceConfigs = [];
    mockClosedInstanceIds = [];
    mockStreamEvents = [];
    mockStartThreadId = 'mock-thread-id';
    delete process.env.OPENAI_BASE_URL;
    vi.clearAllMocks();
    appServerMocks.forkCodexThreadViaAppServer.mockReset();
  });

  it('preserves client dynamic tools and native image events in the Disco behavior stream', async () => {
    const { service } = await makeInitializedStreamingService('existing-thread-id');
    configMocks.getDaemonUrl.mockResolvedValue('http://127.0.0.1:3030');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        params: { arguments: { files: Array<{ path: string }> } };
      };
      const viewed = body.params.arguments.files[0]?.path.endsWith('input.png');
      const publication = {
        type: 'disco_file_publication',
        published: true,
        sessionId: 'session-1',
        userId: 'user-1',
        files: [
          viewed
            ? {
                ref: 'upl_viewed_image',
                filename: 'input.png',
                mimeType: 'image/png',
                size: 24,
              }
            : {
                ref: 'upl_generated_image',
                filename: 'result.png',
                mimeType: 'image/png',
                size: 42,
              },
        ],
      };
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'disco-auto-publish-1',
          result: { structuredContent: publication },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    mockStreamEvents = [
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: {
          id: 'dynamic-1',
          type: 'dynamic_tool_call',
          namespace: 'media',
          tool: 'preview',
          arguments: { path: 'input.png' },
          status: 'in_progress',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'dynamic-1',
          type: 'dynamic_tool_call',
          namespace: 'media',
          tool: 'preview',
          arguments: { path: 'input.png' },
          status: 'completed',
          content_items: [{ type: 'inputText', text: 'previewed' }],
          success: true,
        },
      },
      {
        type: 'item.completed',
        item: { id: 'view-1', type: 'image_view', path: 'E:/workspace/input.png' },
      },
      {
        type: 'item.completed',
        item: {
          id: 'imagegen-1',
          type: 'image_generation',
          status: 'completed',
          revised_prompt: 'gold circle',
          saved_path: 'E:/workspace/result.png',
        },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2 },
      },
    ];

    const emitted = await drain(service);

    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'tool_start',
        toolUse: expect.objectContaining({ name: 'client.media.preview' }),
      })
    );
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'tool_complete',
        toolUse: expect.objectContaining({
          name: 'client.media.preview',
          output: [{ type: 'inputText', text: 'previewed' }],
          status: 'completed',
        }),
      })
    );
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'tool_complete',
        toolUse: expect.objectContaining({
          name: 'ViewImage',
          input: { filename: 'input.png' },
          output: [
            {
              type: 'image',
              upload_ref: 'upl_viewed_image',
              filename: 'input.png',
              mime_type: 'image/png',
              size: 24,
              available: true,
            },
          ],
        }),
      })
    );
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'tool_complete',
        toolUse: expect.objectContaining({
          name: 'image_generation',
          input: { prompt: 'gold circle' },
          output: expect.stringContaining('E:/workspace/result.png'),
          status: 'completed',
        }),
      })
    );
    const final = emitted.find(
      (event) =>
        event.type === 'complete' &&
        Array.isArray(event.content) &&
        (event.content as Array<{ type?: string; text?: string }>).some((block) =>
          block.text?.includes('upl_generated_image')
        )
    );
    expect(final).toBeDefined();
    const visibleText = ((final?.content ?? []) as Array<{ type?: string; text?: string }>)
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n');
    expect(visibleText).toContain('upl_generated_image');
    expect(visibleText).not.toContain('upl_viewed_image');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:3030/mcp',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      })
    );
    fetchSpy.mockRestore();
  });

  it('keeps a completed image-view action usable when its browser preview cannot be published', async () => {
    const { service } = await makeInitializedStreamingService('existing-thread-id');
    configMocks.getDaemonUrl.mockResolvedValue('http://127.0.0.1:3030');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    mockStreamEvents = [
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: { id: 'view-1', type: 'image_view', path: 'E:/private/input.png' },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2 },
      },
    ];

    const emitted = await drain(service);
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'tool_complete',
        toolUse: expect.objectContaining({
          name: 'ViewImage',
          input: { filename: 'input.png' },
          output: [
            {
              type: 'image',
              filename: 'input.png',
              mime_type: 'image/png',
              available: false,
              unavailable_reason: '图片预览暂不可用',
            },
          ],
          status: 'completed',
        }),
      })
    );
    expect(JSON.stringify(emitted)).not.toContain('E:/private/input.png');
    fetchSpy.mockRestore();
  });

  it('turns streamed Codex file directives into one published structured card', async () => {
    const { service } = await makeInitializedStreamingService('existing-thread-id');
    configMocks.getDaemonUrl.mockResolvedValue('http://127.0.0.1:3030');
    const publication = {
      type: 'disco_file_publication',
      published: true,
      sessionId: 'session-1',
      userId: 'user-1',
      files: [
        {
          ref: 'upl_00000000-0000-4000-8000-000000000019',
          filename: 'report.pdf',
          mimeType: 'application/pdf',
          size: 2048,
        },
      ],
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'disco-auto-publish-1',
          result: { structuredContent: publication },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const fullText =
      '已创建 :codex-file-citation{path="E:/workspace/report.pdf" purpose="output"}，请查收。';
    mockStreamEvents = [
      { type: 'turn.started' },
      {
        type: 'agent_message_delta',
        itemId: 'message-file',
        delta: '已创建 :codex-file-ci',
      },
      {
        type: 'agent_message_delta',
        itemId: 'message-file',
        delta: 'tation{path="E:/workspace/report.pdf" purpose="output"}，请查收。',
      },
      {
        type: 'item.completed',
        item: { id: 'message-file', type: 'agent_message', text: fullText },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2 },
      },
    ];

    const emitted = await drain(service);
    const streamedText = emitted
      .filter((event) => event.type === 'partial')
      .map((event) => event.textChunk)
      .join('');
    const citationCompletion = emitted.find(
      (event) =>
        event.type === 'complete' &&
        Array.isArray(event.content) &&
        (event.content as Array<Record<string, unknown>>).some(
          (block) => block.type === 'file_citation'
        )
    );

    expect(streamedText).toBe('已创建 ，请查收。');
    expect(streamedText).not.toContain('codex-file-citation');
    expect(citationCompletion).toMatchObject({
      type: 'complete',
      content: [
        { type: 'text', text: '已创建 ' },
        {
          type: 'file_citation',
          filename: 'report.pdf',
          purpose: 'output',
          upload_ref: 'upl_00000000-0000-4000-8000-000000000019',
          available: true,
        },
        { type: 'text', text: '，请查收。' },
      ],
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    fetchSpy.mockRestore();
  });

  it('turns a streamed visualize directive into one published inline visualization', async () => {
    const { service } = await makeInitializedStreamingService('existing-thread-id');
    configMocks.getDaemonUrl.mockResolvedValue('http://127.0.0.1:3030');
    const publication = {
      type: 'disco_file_publication',
      published: true,
      sessionId: 'session-1',
      userId: 'user-1',
      files: [
        {
          ref: 'upl_00000000-0000-4000-8000-000000000029',
          filename: 'route-map.html',
          mimeType: 'text/html',
          size: 4096,
        },
      ],
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'disco-auto-publish-1',
          result: { structuredContent: publication },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const fullText =
      '路线：visualize{"path":"E:/workspace/route-map.html","title":"湖滨 5K","mode":"wide"}。';
    mockStreamEvents = [
      { type: 'turn.started' },
      { type: 'agent_message_delta', itemId: 'message-visual', delta: '路线：visua' },
      {
        type: 'agent_message_delta',
        itemId: 'message-visual',
        delta: 'lize{"path":"E:/workspace/route-map.html","title":"湖滨 5K",',
      },
      {
        type: 'agent_message_delta',
        itemId: 'message-visual',
        delta: '"mode":"wide"}。',
      },
      {
        type: 'item.completed',
        item: { id: 'message-visual', type: 'agent_message', text: fullText },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2 },
      },
    ];

    const emitted = await drain(service);
    const streamedText = emitted
      .filter((event) => event.type === 'partial')
      .map((event) => event.textChunk)
      .join('');
    const completion = emitted.find(
      (event) =>
        event.type === 'complete' &&
        Array.isArray(event.content) &&
        (event.content as Array<Record<string, unknown>>).some(
          (block) => block.type === 'file_citation'
        )
    );

    expect(streamedText).toBe('路线：。');
    expect(streamedText).not.toContain('visualize');
    expect(completion).toMatchObject({
      type: 'complete',
      content: [
        { type: 'text', text: '路线：' },
        {
          type: 'file_citation',
          filename: 'route-map.html',
          purpose: 'output',
          upload_ref: 'upl_00000000-0000-4000-8000-000000000029',
          mime_type: 'text/html',
          available: true,
          presentation: { type: 'visualization', mode: 'wide', title: '湖滨 5K' },
        },
        { type: 'text', text: '。' },
      ],
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    fetchSpy.mockRestore();
  });

  it('surfaces event_msg agent_message via the actual "message" field (real rollout shape)', async () => {
    // Actual payload shape from failed-run logs:
    //   { type: "agent_message", message: "...", phase: "...", memory_citation: ... }
    const service = makeStreamingService();
    const serviceWithPrivates = service as any;
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/disco-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    mockStreamEvents = [
      { type: 'turn.started' },
      {
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          message: 'All changes have been applied.',
          phase: 'completed',
          memory_citation: null,
        },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
      },
    ];

    const emitted: Array<Record<string, unknown>> = [];
    for await (const event of service.promptSessionStreaming('session-1' as any, 'go')) {
      emitted.push(event as Record<string, unknown>);
    }

    const textBlocks = emitted.filter(
      (e) =>
        e.type === 'complete' &&
        Array.isArray(e.content) &&
        (e.content as Array<{ type: string; text?: string }>).some(
          (c) => c.type === 'text' && c.text === 'All changes have been applied.'
        )
    );
    expect(textBlocks.length).toBeGreaterThanOrEqual(1);
  });

  it('treats event_msg task_complete (real rollout shape) as terminal success', async () => {
    // Actual payload shape from failed-run logs:
    //   { type: "task_complete", turn_id: "...", last_agent_message: "...",
    //     duration_ms: 900000, time_to_first_token_ms: 1234, completed_at: "..." }
    const service = makeStreamingService();
    const serviceWithPrivates = service as any;
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/disco-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    mockStreamEvents = [
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'echo hi',
          aggregated_output: 'hi\n',
          status: 'success',
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-abc123',
          last_agent_message: 'Done. The script ran successfully.',
          duration_ms: 900000,
          time_to_first_token_ms: 1234,
          completed_at: '2026-07-01T13:00:00Z',
        },
      },
      // No turn.completed — this is the new rollout format.
    ];

    const emitted: Array<Record<string, unknown>> = [];
    for await (const event of service.promptSessionStreaming('session-1' as any, 'go')) {
      emitted.push(event as Record<string, unknown>);
    }

    const completeEvents = emitted.filter((e) => e.type === 'complete');
    expect(completeEvents.length).toBeGreaterThanOrEqual(1);

    const last = completeEvents.at(-1);
    expect(last?.threadId).toBe('mock-thread-id');

    // last_agent_message must appear in content when no prior agent_message pushed text
    const content = last?.content as Array<{ type: string; text?: string }>;
    expect(
      content.some((c) => c.type === 'text' && c.text === 'Done. The script ran successfully.')
    ).toBe(true);
  });

  it('treats event_msg turn_complete alias as terminal success', async () => {
    const service = makeStreamingService();
    const serviceWithPrivates = service as any;
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/disco-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    mockStreamEvents = [
      { type: 'turn.started' },
      {
        type: 'event_msg',
        payload: {
          type: 'turn_complete',
          turn_id: 'turn-v2',
          last_agent_message: 'Done via turn_complete.',
        },
      },
    ];

    const emitted: Array<Record<string, unknown>> = [];
    for await (const event of service.promptSessionStreaming('session-1' as any, 'go')) {
      emitted.push(event as Record<string, unknown>);
    }

    const last = emitted.filter((e) => e.type === 'complete').at(-1);
    const content = last?.content as Array<{ type: string; text?: string }>;
    expect(content.some((c) => c.type === 'text' && c.text === 'Done via turn_complete.')).toBe(
      true
    );
  });

  it('surfaces a visible recovery message when a terminal event has no text or media', async () => {
    const service = makeStreamingService();
    const serviceWithPrivates = service as any;
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/disco-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    mockStreamEvents = [
      { type: 'turn.started' },
      {
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-empty', last_agent_message: '' },
      },
    ];

    const emitted: Array<Record<string, unknown>> = [];
    for await (const event of service.promptSessionStreaming('session-1' as any, 'draw this')) {
      emitted.push(event as Record<string, unknown>);
    }

    const last = emitted.filter((event) => event.type === 'complete').at(-1);
    const content = last?.content as Array<{ type: string; text?: string }>;
    expect(content).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('没有返回可展示的文字或媒体结果'),
      }),
    ]);
  });

  it('uses last_agent_message from task_complete when no prior agent_message event provided text', async () => {
    const service = makeStreamingService();
    const serviceWithPrivates = service as any;
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/disco-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    mockStreamEvents = [
      { type: 'turn.started' },
      {
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-xyz',
          last_agent_message: 'Task completed successfully.',
          duration_ms: 12000,
          time_to_first_token_ms: 500,
          completed_at: '2026-07-01T13:00:05Z',
        },
      },
    ];

    const emitted: Array<Record<string, unknown>> = [];
    for await (const event of service.promptSessionStreaming('session-1' as any, 'go')) {
      emitted.push(event as Record<string, unknown>);
    }

    const last = emitted.filter((e) => e.type === 'complete').at(-1);
    const content = last?.content as Array<{ type: string; text?: string }>;
    expect(
      content.some((c) => c.type === 'text' && c.text === 'Task completed successfully.')
    ).toBe(true);
  });

  it('does not duplicate text when agent_message already pushed the same content before task_complete', async () => {
    const service = makeStreamingService();
    const serviceWithPrivates = service as any;
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/disco-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    const finalText = 'All done!';

    mockStreamEvents = [
      { type: 'turn.started' },
      {
        type: 'event_msg',
        // agent_message pushes the text first
        payload: { type: 'agent_message', message: finalText, phase: 'completed' },
      },
      {
        type: 'event_msg',
        // task_complete carries the same text in last_agent_message
        payload: {
          type: 'task_complete',
          turn_id: 'turn-dup',
          last_agent_message: finalText,
          duration_ms: 5000,
          time_to_first_token_ms: 200,
          completed_at: '2026-07-01T13:00:10Z',
        },
      },
    ];

    const emitted: Array<Record<string, unknown>> = [];
    for await (const event of service.promptSessionStreaming('session-1' as any, 'go')) {
      emitted.push(event as Record<string, unknown>);
    }

    const completeEvents = emitted.filter((e) => e.type === 'complete');
    expect(completeEvents).toHaveLength(1);

    const finalComplete = completeEvents.at(-1);
    const content = finalComplete?.content as Array<{ type: string; text?: string }>;
    // There should be exactly one text block with finalText, not two.
    const textOccurrences = content.filter((c) => c.type === 'text' && c.text === finalText);
    expect(textOccurrences).toHaveLength(1);
  });

  it('preserves distinct agent_message and last_agent_message text blocks', async () => {
    const service = makeStreamingService();
    const serviceWithPrivates = service as any;
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/disco-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    mockStreamEvents = [
      { type: 'turn.started' },
      {
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Progress update.', phase: 'running' },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-final',
          last_agent_message: 'Final answer.',
        },
      },
    ];

    const emitted: Array<Record<string, unknown>> = [];
    for await (const event of service.promptSessionStreaming('session-1' as any, 'go')) {
      emitted.push(event as Record<string, unknown>);
    }

    const finalComplete = emitted.filter((e) => e.type === 'complete').at(-1);
    const content = finalComplete?.content as Array<{ type: string; text?: string }>;
    expect(content.filter((c) => c.type === 'text').map((c) => c.text)).toEqual([
      'Progress update.',
      'Final answer.',
    ]);
  });

  it('carries event_msg token_count context snapshot into the task_complete complete event', async () => {
    const service = makeStreamingService();
    const serviceWithPrivates = service as any;
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/disco-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    mockStreamEvents = [
      { type: 'turn.started' },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { total_tokens: 30_000 },
            model_context_window: 272_000,
          },
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'task_complete' },
      },
    ];

    const emitted: Array<Record<string, unknown>> = [];
    for await (const event of service.promptSessionStreaming('session-1' as any, 'go')) {
      emitted.push(event as Record<string, unknown>);
    }

    const last = emitted.filter((e) => e.type === 'complete').at(-1);
    expect(last?.rawContextUsage).toMatchObject({
      totalTokens: 30_000,
      maxTokens: 272_000,
    });
  });

  it('ignores reconnect progress until turn.completed and preserves the existing thread', async () => {
    const { service } = await makeInitializedStreamingService('existing-thread-id');

    const reconnectMessage =
      'Reconnecting... 2/5 (stream disconnected before completion: websocket closed by server before response.completed)';
    mockStreamEvents = [
      { type: 'error', message: reconnectMessage },
      {
        type: 'turn.completed',
        usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2 },
      },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const emitted: Array<Record<string, unknown>> = [];
    for await (const event of service.promptSessionStreaming('session-1' as any, 'go')) {
      emitted.push(event as Record<string, unknown>);
    }

    expect(emitted.some((event) => event.type === 'complete')).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(reconnectMessage));
    expect(mockSessionsRepo.update).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it.each([
    ['fresh', null],
    ['established', 'existing-thread-id'],
  ])(
    'lets turn.failed remain authoritative after reconnect progress for a %s thread',
    async (_threadKind, sdkSessionId) => {
      const { service } = await makeInitializedStreamingService(sdkSessionId);

      mockStreamEvents = [
        { type: 'error', message: 'Reconnecting... 2/5' },
        { type: 'turn.failed', error: { message: 'provider rejected the turn' } },
      ];
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(drain(service)).rejects.toThrow('provider rejected the turn');

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Reconnecting... 2/5'));
      expect(mockSessionsRepo.update).not.toHaveBeenCalled();
      warn.mockRestore();
    }
  );

  it.each([
    ['reconnecting... 2/5', 'lowercase'],
    ['Reconnecting...', 'missing N/M'],
    [' Reconnecting... 2/5', 'leading whitespace'],
    ['Error: Reconnecting... 2/5', 'prefixed text'],
  ])('treats %s as a fatal stream error (%s)', async (message) => {
    const { service } = await makeInitializedStreamingService('existing-thread-id');

    mockStreamEvents = [{ type: 'error', message }];

    await expect(drain(service)).rejects.toThrow(`Codex stream error: ${message}`);

    expect(mockSessionsRepo.update).not.toHaveBeenCalled();
  });

  it('turns a terminal model-capacity stream failure into an actionable message', async () => {
    const { service } = await makeInitializedStreamingService('existing-thread-id');

    mockStreamEvents = [
      {
        type: 'error',
        message: 'Selected model is at capacity. Please try a different model.',
      },
    ];

    await expect(drain(service)).rejects.toThrow(
      '远端模型服务持续繁忙，Disco 已完成自动重试但仍未恢复。请立即重试，或切换其他模型。'
    );
    expect(mockSessionsRepo.update).not.toHaveBeenCalled();
  });

  it('distinguishes an expired Codex subscription login from the Disco browser login', async () => {
    const { service } = await makeInitializedStreamingService('existing-thread-id');
    const internals = service as unknown as { apiKey: string; useNativeAuth: boolean };
    internals.apiKey = '';
    internals.useNativeAuth = true;

    mockStreamEvents = [
      {
        type: 'error',
        message: 'Your access token could not be refreshed. Please log out and sign in again.',
      },
    ];

    await expect(drain(service)).rejects.toThrow(
      'Codex 登录已失效，Disco 网页登录仍然有效。请在“设置 → Codex 连接”重新连接后重试；退出再登录 Disco 无法刷新 Codex 登录。'
    );
    expect(mockSessionsRepo.update).not.toHaveBeenCalled();
  });

  it.each([
    ['fresh', null],
    ['established', 'existing-thread-id'],
  ])(
    'throws on pre-terminal EOF and only clears a %s thread invocation',
    async (_threadKind, sdkSessionId) => {
      const { service } = await makeInitializedStreamingService(sdkSessionId);

      // Stream ends with no terminal event — simulates process exit with code 0
      mockStreamEvents = [
        { type: 'turn.started' },
        { type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'ls' } },
        // Stream just ends — no turn.completed, turn.failed, task_complete, or error
      ];

      await expect(drain(service)).rejects.toThrow(
        'Codex stream ended without a terminal completion event'
      );

      if (sdkSessionId === null) {
        expect(mockSessionsRepo.update).toHaveBeenCalledWith('session-1', {
          sdk_session_id: null,
        });
      } else {
        expect(mockSessionsRepo.update).not.toHaveBeenCalled();
      }
    }
  );

  it.each([
    ['before event iteration', null],
    ['before event iteration', 'existing-thread-id'],
    ['while iterating events', null],
    ['while iterating events', 'existing-thread-id'],
  ])(
    'only clears fresh thread state when transport fails %s (sdk_session_id=%s)',
    async (failurePoint, sdkSessionId) => {
      const { service, codex } = await makeInitializedStreamingService(sdkSessionId);

      const thread = {
        id: sdkSessionId ?? 'fresh-thread-id',
        run: vi.fn(),
        runStreamed:
          failurePoint === 'before event iteration'
            ? vi.fn().mockRejectedValue(new Error('runStreamed aborted unexpectedly'))
            : vi.fn().mockResolvedValue({
                events: (async function* () {
                  yield { type: 'turn.started' };
                  throw new Error('event iterator failed');
                })(),
              }),
      };
      if (sdkSessionId) {
        codex.resumeThread = vi.fn(() => thread);
      } else {
        codex.startThread = vi.fn(() => thread);
      }

      await expect(drain(service)).rejects.toThrow(
        failurePoint === 'before event iteration'
          ? 'runStreamed aborted unexpectedly'
          : 'event iterator failed'
      );

      if (sdkSessionId === null) {
        expect(mockSessionsRepo.update).toHaveBeenCalledWith('session-1', {
          sdk_session_id: null,
        });
      } else {
        expect(mockSessionsRepo.update).not.toHaveBeenCalled();
      }
    }
  );

  it('treats an actually aborted controller as stopped and preserves the established thread', async () => {
    const { service, codex } = await makeInitializedStreamingService('existing-thread-id');
    const abortController = new AbortController();
    abortController.abort();
    codex.resumeThread = vi.fn(() => ({
      id: 'existing-thread-id',
      run: vi.fn(),
      runStreamed: vi.fn().mockRejectedValue(new Error('transport failed after cancellation')),
    }));

    const emitted = await drain(service, abortController);

    expect(emitted).toContainEqual({
      type: 'stopped',
      threadId: 'existing-thread-id',
    });
    expect(mockSessionsRepo.update).not.toHaveBeenCalled();
  });

  it('does not throw when stream ends after a user-requested stop', async () => {
    const service = makeStreamingService();
    const serviceWithPrivates = service as any;
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/disco-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    // The service clears stale stop flags before streaming starts, so calling
    // stopTask() before promptSessionStreaming() has no effect. Instead, we
    // override the mock Codex thread to signal the stop mid-stream (between
    // yields) — the same ordering that occurs in production when the UI calls
    // stopTask() while events are streaming.
    const mockCodexClient = serviceWithPrivates.codex;
    mockCodexClient.startThread = vi.fn(() => ({
      id: 'mock-thread-id',
      run: vi.fn(),
      runStreamed: vi.fn().mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.started' };
          // Signal stop after the first event — before the next event is
          // processed the for-await loop will check stopRequested and break.
          service.stopTask('session-1' as any);
          yield {
            type: 'item.started',
            item: { id: 'x', type: 'command_execution', command: 'ls' },
          };
          // This event is never reached because the stop check fires first.
          yield { type: 'turn.completed', usage: {} };
        })(),
      }),
    }));

    const emitted: Array<Record<string, unknown>> = [];
    await expect(
      (async () => {
        for await (const event of service.promptSessionStreaming('session-1' as any, 'go')) {
          emitted.push(event as Record<string, unknown>);
        }
      })()
    ).resolves.toBeUndefined();

    expect(emitted.some((e) => e.type === 'stopped')).toBe(true);
  });

  it('ignores unknown event_msg payload types without throwing', async () => {
    const service = makeStreamingService();
    const serviceWithPrivates = service as any;
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/disco-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    mockStreamEvents = [
      { type: 'turn.started' },
      { type: 'event_msg', payload: { type: 'some_future_payload_type', data: {} } },
      {
        type: 'turn.completed',
        usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2 },
      },
    ];

    const emitted: Array<Record<string, unknown>> = [];
    for await (const event of service.promptSessionStreaming('session-1' as any, 'go')) {
      emitted.push(event as Record<string, unknown>);
    }

    expect(emitted.some((e) => e.type === 'complete')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MCP server config builder
//
// Regression coverage for the fix in this PR: every Codex MCP server config
// Disco emits must carry `default_tools_approval_mode: "approve"`. Without it,
// Codex's elicitation layer prompts for every MCP tool call, and in headless
// `exec --json` mode (what @openai/codex-sdk uses) those prompts resolve to
// "user cancelled MCP tool call". See
// codex-rs/codex-mcp/src/mcp/mod.rs::mcp_permission_prompt_is_auto_approved.
// ─────────────────────────────────────────────────────────────────────────────
describe('CodexPromptService - buildMcpServersConfig', () => {
  const sessionOwnerId = '019e3700-owner-owner-owner-owner000001';
  const mockMcpServerRepo = {
    findById: vi.fn(),
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mcpScopingMocks.getMcpServersForSession.mockResolvedValue([]);
    mcpAuthMocks.resolveMCPAuthHeaders.mockResolvedValue(null);
    configMocks.getDaemonUrl.mockResolvedValue('http://localhost:3030');
  });

  const makeService = () =>
    new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      'test-api-key',
      mockMcpServerRepo
    );

  it('emits default_tools_approval_mode=approve on the built-in disco server', async () => {
    const service = makeService();
    const { servers, total } = await (service as any).buildMcpServersConfig(
      '019e3700-aaaa-bbbb-cccc-dddddddddddd',
      'disco-bearer-token',
      { sessionOwnerId }
    );

    expect(total).toBe(1);
    expect(servers.disco).toMatchObject({
      url: 'http://localhost:3030/mcp',
      default_tools_approval_mode: 'approve',
    });
  });

  it('passes forUserId to shared MCP scoping for per-user OAuth injection', async () => {
    const service = makeService();

    await (service as any).buildMcpServersConfig(
      '019e3700-aaaa-bbbb-cccc-dddddddddddd',
      undefined,
      {
        forUserId: '019e3700-user-user-user-user00000001',
        sessionOwnerId,
      }
    );

    expect(mcpScopingMocks.getMcpServersForSession).toHaveBeenCalledWith(
      '019e3700-aaaa-bbbb-cccc-dddddddddddd',
      expect.objectContaining({
        forUserId: '019e3700-user-user-user-user00000001',
        sessionOwnerId,
      }),
      // Codex can drop individual tools but has no way to prompt.
      { toolFiltering: 'exclude' }
    );
  });

  it('emits default_tools_approval_mode=approve on a stdio server', async () => {
    mcpScopingMocks.getMcpServersForSession.mockResolvedValue([
      {
        server: {
          name: 'github',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: 'xxx' },
        },
      },
    ]);

    const service = makeService();
    const { servers, total } = await (service as any).buildMcpServersConfig(
      '019e3700-aaaa-bbbb-cccc-dddddddddddd',
      undefined,
      { sessionOwnerId }
    );

    expect(total).toBe(1);
    expect(servers.github).toMatchObject({
      command: 'npx',
      default_tools_approval_mode: 'approve',
    });
  });

  it('emits default_tools_approval_mode=approve on an http/sse server', async () => {
    mcpScopingMocks.getMcpServersForSession.mockResolvedValue([
      {
        server: {
          name: 'remote',
          transport: 'http',
          url: 'https://example.com/mcp',
        },
      },
    ]);

    const service = makeService();
    const { servers, total } = await (service as any).buildMcpServersConfig(
      '019e3700-aaaa-bbbb-cccc-dddddddddddd',
      undefined,
      { sessionOwnerId }
    );

    expect(total).toBe(1);
    expect(servers.remote).toMatchObject({
      url: 'https://example.com/mcp',
      default_tools_approval_mode: 'approve',
    });
  });

  it('passes custom HTTP headers through Codex env_http_headers without inlining secrets', async () => {
    mcpScopingMocks.getMcpServersForSession.mockResolvedValue([
      {
        server: {
          name: 'userguiding',
          transport: 'http',
          url: 'https://example.com/mcp',
          auth: { type: 'none' },
          headers: {
            'X-API-Key': 'secret-api-key',
            'X-Workspace': 'workspace-123',
          },
        },
      },
    ]);

    const service = makeService();
    try {
      const { servers, total } = await (service as any).buildMcpServersConfig(
        '019e3700-aaaa-bbbb-cccc-dddddddddddd',
        undefined,
        { sessionOwnerId }
      );

      expect(total).toBe(1);
      expect(servers.userguiding).toMatchObject({
        url: 'https://example.com/mcp',
        env_http_headers: {
          'X-API-Key': 'DISCO_MCP_019e3700aaaabbbbccccdddd_USERGUIDING_HEADER_1',
          'X-Workspace': 'DISCO_MCP_019e3700aaaabbbbccccdddd_USERGUIDING_HEADER_2',
        },
      });
      expect(servers.userguiding).not.toHaveProperty('headers');
      expect(servers.userguiding).not.toHaveProperty('http_headers');
      expect(process.env.DISCO_MCP_019e3700aaaabbbbccccdddd_USERGUIDING_HEADER_1).toBe(
        'secret-api-key'
      );
      expect(process.env.DISCO_MCP_019e3700aaaabbbbccccdddd_USERGUIDING_HEADER_2).toBe(
        'workspace-123'
      );
    } finally {
      delete process.env.DISCO_MCP_019e3700aaaabbbbccccdddd_USERGUIDING_HEADER_1;
      delete process.env.DISCO_MCP_019e3700aaaabbbbccccdddd_USERGUIDING_HEADER_2;
    }
  });

  it('applies default_tools_approval_mode=approve to ALL servers in a mixed config', async () => {
    mcpScopingMocks.getMcpServersForSession.mockResolvedValue([
      {
        server: {
          name: 'github',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
        },
      },
      {
        server: {
          name: 'linear',
          transport: 'http',
          url: 'https://mcp.linear.app/sse',
        },
      },
    ]);

    const service = makeService();
    const { servers, total } = await (service as any).buildMcpServersConfig(
      '019e3700-aaaa-bbbb-cccc-dddddddddddd',
      'disco-bearer-token',
      { sessionOwnerId }
    );

    expect(total).toBe(3);
    for (const name of ['disco', 'github', 'linear']) {
      expect(servers[name], `server "${name}" missing approval mode`).toMatchObject({
        default_tools_approval_mode: 'approve',
      });
    }
  });

  it('keeps the built-in Disco MCP config compatible with the Codex transport', async () => {
    const service = makeService();
    const { servers, total } = await (service as any).buildMcpServersConfig(
      '019e3700-aaaa-bbbb-cccc-dddddddddddd',
      'disco-bearer-token',
      { sessionOwnerId }
    );

    expect(total).toBe(1);
    expect(servers.disco).toMatchObject({
      default_tools_approval_mode: 'approve',
      url: 'http://localhost:3030/mcp',
    });
    expect(servers.disco.required).toBeUndefined();
    expect(servers.disco.startup_timeout_ms).toBeUndefined();
  });

  it('keeps attached MCP servers free of unsupported startup guard fields', async () => {
    mcpScopingMocks.getMcpServersForSession.mockResolvedValue([
      {
        server: {
          name: 'github',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
        },
      },
      {
        server: {
          name: 'linear',
          transport: 'http',
          url: 'https://mcp.linear.app/sse',
        },
      },
    ]);

    const service = makeService();
    const { servers, total } = await (service as any).buildMcpServersConfig(
      '019e3700-aaaa-bbbb-cccc-dddddddddddd',
      'disco-bearer-token',
      { sessionOwnerId }
    );

    expect(total).toBe(3);
    for (const name of ['disco', 'github', 'linear']) {
      expect(
        servers[name].required,
        `server "${name}" must stay transport-compatible`
      ).toBeUndefined();
      expect(servers[name].startup_timeout_ms).toBeUndefined();
    }
  });

  it('does not require unauthenticated OAuth MCP servers for gateway sessions', async () => {
    mcpScopingMocks.getMcpServersForSession.mockResolvedValue([
      {
        server: {
          name: 'oauthRemote',
          transport: 'http',
          url: 'https://example.com/mcp',
          auth: { type: 'oauth' },
        },
      },
    ]);
    mcpAuthMocks.resolveMCPAuthHeaders.mockResolvedValue(null);

    const service = makeService();
    const { servers, total } = await (service as any).buildMcpServersConfig(
      '019e3700-aaaa-bbbb-cccc-dddddddddddd',
      undefined,
      { sessionOwnerId }
    );

    expect(total).toBe(1);
    expect(servers.oauthremote).toMatchObject({
      default_tools_approval_mode: 'approve',
    });
    expect(servers.oauthremote.required).toBeUndefined();
    expect(servers.oauthremote.startup_timeout_ms).toBeUndefined();
  });

  it('does not require remote Bearer or JWT MCP servers without resolved auth', async () => {
    mcpScopingMocks.getMcpServersForSession.mockResolvedValue([
      {
        server: {
          name: 'bearerRemote',
          transport: 'http',
          url: 'https://bearer.example.com/mcp',
          auth: { type: 'bearer' },
        },
      },
      {
        server: {
          name: 'jwtRemote',
          transport: 'http',
          url: 'https://jwt.example.com/mcp',
          auth: { type: 'jwt' },
        },
      },
    ]);
    mcpAuthMocks.resolveMCPAuthHeaders.mockResolvedValue(null);

    const service = makeService();
    const { servers, total } = await (service as any).buildMcpServersConfig(
      '019e3700-aaaa-bbbb-cccc-dddddddddddd',
      undefined,
      { sessionOwnerId }
    );

    expect(total).toBe(2);
    for (const name of ['bearerremote', 'jwtremote']) {
      expect(servers[name], `server "${name}" should remain optional`).toMatchObject({
        default_tools_approval_mode: 'approve',
      });
      expect(servers[name].required).toBeUndefined();
      expect(servers[name].startup_timeout_ms).toBeUndefined();
    }
  });
});
