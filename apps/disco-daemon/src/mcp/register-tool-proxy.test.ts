import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { filteredToolRegistrationProxy } from './register-tool-proxy.js';

describe('filteredToolRegistrationProxy', () => {
  it('does not register methods outside the authenticated audience', () => {
    const registerTool = vi.fn();
    const server = { registerTool } as unknown as McpServer;
    const scoped = filteredToolRegistrationProxy(server, name => name === 'disco_allowed');
    const register = scoped.registerTool.bind(scoped) as unknown as (
      name: string,
      config: Record<string, unknown>,
      handler: () => void
    ) => unknown;

    register('disco_allowed', { description: 'allowed' }, () => undefined);
    register('disco_hidden', { description: 'hidden' }, () => undefined);

    expect(registerTool).toHaveBeenCalledOnce();
    expect(registerTool).toHaveBeenCalledWith(
      'disco_allowed',
      { description: 'allowed' },
      expect.any(Function)
    );
  });
});
