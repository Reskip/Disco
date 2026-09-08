import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  resolveDiscoAgentSessionWorkingDirectory,
  resolveDiscoStandaloneSessionWorkingDirectory,
  resolveDiscoUserWorkspaceDirectory,
} from '@disco/core';
import { prepareDiscoAgentRuntimeContext } from '@disco/core/agent-runtime';
import { createUser, generateId } from '@disco/core/db';
import type { Application } from '@disco/core/feathers';
import { SessionStatus } from '@disco/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { AgentsService } from './agents';
import { SessionsService } from './sessions';

const STUB_APP = {} as unknown as Application;

function resolvedModelConfig() {
  return {
    mode: 'alias' as const,
    model: 'gpt-5.6-sol',
    effort: 'low' as const,
    updated_at: new Date().toISOString(),
  };
}

describe('SessionsService runtime workspace preload', () => {
  dbTest(
    'returns a new Agent session only after its reusable runtime snapshot exists',
    async ({ db }) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'disco-session-preload-'));
      try {
        const worktreesRoot = path.join(root, 'worktrees');
        const user = await createUser(db, {
          username: `preload-${generateId()}`,
          password: 'not-used-by-this-test',
          name: 'Preload owner',
        });
        const agent = await new AgentsService(db, () => worktreesRoot).create(
          {
            display_name: '预加载助手',
            description: '在第一条消息前准备好身份资料。',
          },
          { user } as never
        );

        const created = await new SessionsService(
          db,
          STUB_APP,
          () => true,
          () => worktreesRoot
        ).create(
          {
            agent_id: agent.agent_id,
            status: SessionStatus.IDLE,
            created_by: user.user_id,
            model_config: resolvedModelConfig(),
          },
          { user, _agenticConfigResolved: true } as never
        );

        const sessionWorkspace = resolveDiscoAgentSessionWorkingDirectory(
          agent.workspace_path,
          created.session_id
        );
        expect(created).toMatchObject({
          agentic_tool: 'codex',
          agent_id: agent.agent_id,
          working_directory: sessionWorkspace,
        });
        expect(created).not.toHaveProperty('branch_id');

        const statusPath = path.join(sessionWorkspace, '.disco-runtime', 'preload.json');
        const contextPath = path.join(sessionWorkspace, '.disco-runtime', 'agent-context.md');
        expect(existsSync(statusPath)).toBe(true);
        expect(existsSync(contextPath)).toBe(true);
        expect(JSON.parse(readFileSync(statusPath, 'utf8'))).toMatchObject({
          status: 'ready',
          agent_workspace: path.resolve(agent.workspace_path),
          session_workspace: path.resolve(sessionWorkspace),
        });
        expect(readFileSync(contextPath, 'utf8')).toContain('预加载助手');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  dbTest(
    'creates a standalone session directory without loading any Agent profile',
    async ({ db }) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'disco-standalone-session-'));
      try {
        const worktreesRoot = path.join(root, 'worktrees');
        const user = await createUser(db, {
          username: `standalone-${generateId()}`,
          password: 'not-used-by-this-test',
          name: 'Standalone owner',
        });
        const created = await new SessionsService(
          db,
          STUB_APP,
          () => true,
          () => worktreesRoot
        ).create(
          {
            status: SessionStatus.IDLE,
            created_by: user.user_id,
            model_config: resolvedModelConfig(),
          },
          { user, _agenticConfigResolved: true } as never
        );
        const userRoot = resolveDiscoUserWorkspaceDirectory(worktreesRoot, user.user_id);
        const sessionWorkspace = resolveDiscoStandaloneSessionWorkingDirectory(
          userRoot,
          created.session_id
        );

        expect(created).toMatchObject({
          agentic_tool: 'codex',
          agent_id: null,
          working_directory: sessionWorkspace,
        });
        expect(created).not.toHaveProperty('branch_id');
        expect(existsSync(sessionWorkspace)).toBe(true);
        expect(existsSync(path.join(sessionWorkspace, '.disco-runtime', 'agent-context.md'))).toBe(
          false
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  dbTest(
    'refreshes an existing Agent session snapshot after the canonical profile changes',
    async ({ db }) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'disco-session-profile-refresh-'));
      try {
        const worktreesRoot = path.join(root, 'worktrees');
        const user = await createUser(db, {
          username: `refresh-${generateId()}`,
          password: 'not-used-by-this-test',
          name: 'Refresh owner',
        });
        const agents = new AgentsService(db, () => worktreesRoot);
        const agent = await agents.create({ display_name: '初始身份', description: '初始职责' }, {
          user,
        } as never);
        const created = await new SessionsService(
          db,
          STUB_APP,
          () => true,
          () => worktreesRoot
        ).create(
          {
            agent_id: agent.agent_id,
            status: SessionStatus.IDLE,
            created_by: user.user_id,
            model_config: resolvedModelConfig(),
          },
          { user, _agenticConfigResolved: true } as never
        );
        const contextPath = path.join(
          created.working_directory,
          '.disco-runtime',
          'agent-context.md'
        );
        const statusPath = path.join(created.working_directory, '.disco-runtime', 'preload.json');
        const firstStatus = JSON.parse(readFileSync(statusPath, 'utf8')) as {
          source_fingerprint: string;
        };
        expect(readFileSync(contextPath, 'utf8')).toContain('初始身份');

        await agents.patch(agent.agent_id, { display_name: '更新身份', description: '更新职责' }, {
          user,
        } as never);
        prepareDiscoAgentRuntimeContext({
          agentWorkspace: agent.workspace_path,
          sessionWorkspace: created.working_directory,
        });

        const refreshedStatus = JSON.parse(readFileSync(statusPath, 'utf8')) as {
          source_fingerprint: string;
        };
        expect(refreshedStatus.source_fingerprint).not.toBe(firstStatus.source_fingerprint);
        expect(readFileSync(contextPath, 'utf8')).toContain('更新身份');
        expect(readFileSync(contextPath, 'utf8')).not.toContain('初始身份');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});
