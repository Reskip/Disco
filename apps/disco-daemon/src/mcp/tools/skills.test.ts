import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import type { McpContext } from '../server.js';
import { registerSkillTools } from './skills.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

function captureHandler(ctx: McpContext, toolName: string): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    registerTool(name: string, _config: unknown, callback: ToolHandler) {
      if (name === toolName) handler = callback;
    },
  } as unknown as McpServer;
  registerSkillTools(server, ctx);
  if (!handler) throw new Error(`${toolName} was not registered`);
  return handler;
}

function captureInstallHandler(ctx: McpContext): ToolHandler {
  return captureHandler(ctx, 'disco_skills_install');
}

function resultJson(result: Awaited<ReturnType<ToolHandler>>) {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function createContext(options: { agentId?: string }) {
  const createAgentSkill = vi.fn(async () => ({ id: 'agent-capability' }));
  const createSharedSkill = vi.fn(async () => ({ id: 'shared-skill' }));
  const findAgentSkills = vi.fn(async () => [
    { id: 'agent-capability', kind: 'skill', name: 'Agent skill', enabled: true },
    { id: 'agent-memory', kind: 'memory', name: 'Memory', enabled: true },
  ]);
  const findSharedSkills = vi.fn(async () => [
    { id: 'shared-skill', name: 'Shared skill', enabled: true },
  ]);
  const patchAgentSkill = vi.fn(async (_id: string, data: Record<string, unknown>) => ({
    id: 'agent-capability',
    ...data,
  }));
  const patchSharedSkill = vi.fn(async (_id: string, data: Record<string, unknown>) => ({
    id: 'shared-skill',
    ...data,
  }));
  const getAgent = vi.fn(async (agentId: string) => ({ agent_id: agentId }));
  const app = {
    service(name: string) {
      if (name === 'agents') return { get: getAgent };
      if (name === 'agent-capabilities') {
        return { create: createAgentSkill, find: findAgentSkills, patch: patchAgentSkill };
      }
      if (name === 'codex-skills') {
        return { create: createSharedSkill, find: findSharedSkills, patch: patchSharedSkill };
      }
      throw new Error(`Unexpected service: ${name}`);
    },
  };
  const ctx = {
    app,
    db: {},
    userId: 'user-1',
    sessionId: 'session-1',
    authenticatedSession: {
      session_id: 'session-1',
      agent_id: options.agentId ?? null,
      agentic_tool: 'codex',
    },
    authenticatedUser: { user_id: 'user-1', role: 'member' },
    baseServiceParams: {
      authenticated: true,
      provider: 'mcp',
      user: { user_id: 'user-1', role: 'member' },
    },
  } as unknown as McpContext;
  return {
    ctx,
    createAgentSkill,
    createSharedSkill,
    findAgentSkills,
    findSharedSkills,
    patchAgentSkill,
    patchSharedSkill,
    getAgent,
  };
}

const installInput = {
  name: 'Evidence Helper',
  skillMarkdown: '---\nname: evidence-helper\n---\n\n# Evidence\n',
};

describe('Disco skill MCP routing', () => {
  it('installs into the current agent when called from an agent session', async () => {
    const context = createContext({ agentId: 'agent-a' });
    const result = resultJson(await captureInstallHandler(context.ctx)(installInput));

    expect(result).toMatchObject({ installed: true, scope: 'agent', target_agent_id: 'agent-a' });
    expect(context.createAgentSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Evidence Helper', source_session_id: 'session-1' }),
      expect.objectContaining({ query: { agent_id: 'agent-a' } })
    );
    expect(context.createSharedSkill).not.toHaveBeenCalled();
  });

  it('installs into Disco shared storage when called from a standalone session', async () => {
    const context = createContext({});
    const result = resultJson(await captureInstallHandler(context.ctx)(installInput));

    expect(result).toMatchObject({ installed: true, scope: 'shared' });
    expect(context.createSharedSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Evidence Helper', source_session_id: 'session-1' }),
      context.ctx.baseServiceParams
    );
    expect(context.createAgentSkill).not.toHaveBeenCalled();
  });

  it('routes an explicit target to that owned agent instead of the current standalone scope', async () => {
    const context = createContext({});
    const result = resultJson(
      await captureInstallHandler(context.ctx)({ ...installInput, targetAgentId: 'agent-b' })
    );

    expect(result).toMatchObject({ installed: true, scope: 'agent', target_agent_id: 'agent-b' });
    expect(context.createAgentSkill).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ query: { agent_id: 'agent-b' } })
    );
    expect(context.createSharedSkill).not.toHaveBeenCalled();
  });

  it('rejects a forged target Agent before writing any skill files', async () => {
    const context = createContext({});
    context.getAgent.mockRejectedValueOnce(new Error('Agent not found'));

    await expect(
      captureInstallHandler(context.ctx)({ ...installInput, targetAgentId: 'another-user-agent' })
    ).rejects.toThrow('Agent not found');
    expect(context.createAgentSkill).not.toHaveBeenCalled();
    expect(context.createSharedSkill).not.toHaveBeenCalled();
  });

  it('lists only skills from the current Agent management source', async () => {
    const context = createContext({ agentId: 'agent-a' });
    const result = resultJson(await captureHandler(context.ctx, 'disco_skills_list')({}));

    expect(result).toEqual([
      { id: 'agent-capability', kind: 'skill', name: 'Agent skill', enabled: true },
    ]);
    expect(context.findAgentSkills).toHaveBeenCalledWith(
      expect.objectContaining({ query: { agent_id: 'agent-a' } })
    );
    expect(context.findSharedSkills).not.toHaveBeenCalled();
  });

  it('lists Disco shared skills from a standalone session', async () => {
    const context = createContext({});
    const result = resultJson(await captureHandler(context.ctx, 'disco_skills_list')({}));

    expect(result).toEqual([{ id: 'shared-skill', name: 'Shared skill', enabled: true }]);
    expect(context.findSharedSkills).toHaveBeenCalledOnce();
    expect(context.findAgentSkills).not.toHaveBeenCalled();
  });

  it('disables an Agent skill without uninstalling it', async () => {
    const context = createContext({ agentId: 'agent-a' });
    const result = resultJson(
      await captureHandler(
        context.ctx,
        'disco_skills_set_enabled'
      )({
        capabilityId: 'agent-capability',
        enabled: false,
      })
    );

    expect(result).toMatchObject({ id: 'agent-capability', enabled: false });
    expect(context.patchAgentSkill).toHaveBeenCalledWith(
      'agent-capability',
      { enabled: false },
      expect.objectContaining({ query: { agent_id: 'agent-a' } })
    );
  });

  it('enables a Disco shared skill through the shared lifecycle source', async () => {
    const context = createContext({});
    const result = resultJson(
      await captureHandler(
        context.ctx,
        'disco_skills_set_enabled'
      )({
        skillId: 'shared-skill',
        enabled: true,
      })
    );

    expect(result).toMatchObject({ id: 'shared-skill', enabled: true });
    expect(context.patchSharedSkill).toHaveBeenCalledWith(
      'shared-skill',
      { enabled: true },
      context.ctx.baseServiceParams
    );
  });

  it('passes permanent Agent uninstall through the confirmed lifecycle action', async () => {
    const context = createContext({ agentId: 'agent-a' });
    const result = resultJson(
      await captureHandler(
        context.ctx,
        'disco_skills_uninstall'
      )({
        capabilityId: 'agent-capability',
        confirmation: 'Agent skill',
      })
    );

    expect(result).toMatchObject({
      id: 'agent-capability',
      action: 'uninstall',
      confirmation: 'Agent skill',
    });
    expect(context.patchAgentSkill).toHaveBeenCalledWith(
      'agent-capability',
      { action: 'uninstall', confirmation: 'Agent skill' },
      expect.objectContaining({ query: { agent_id: 'agent-a' } })
    );
  });

  it('requires exactly one managed skill identifier for lifecycle mutations', async () => {
    const context = createContext({ agentId: 'agent-a' });
    const setEnabled = captureHandler(context.ctx, 'disco_skills_set_enabled');
    const uninstall = captureHandler(context.ctx, 'disco_skills_uninstall');

    await expect(setEnabled({ enabled: false })).rejects.toThrow(
      'Provide exactly one of capabilityId or skillId'
    );
    await expect(
      uninstall({
        capabilityId: 'agent-capability',
        skillId: 'shared-skill',
        confirmation: 'x',
      })
    ).rejects.toThrow('Provide exactly one of capabilityId or skillId');
  });
});
