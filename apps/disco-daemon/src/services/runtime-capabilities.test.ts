import { describe, expect, it } from 'vitest';
import { buildRegistry, getRuntimeCapabilityCatalog } from '../mcp/server.js';
import { createRuntimeCapabilitiesService } from './runtime-capabilities.js';

describe('RuntimeCapabilitiesService', () => {
  it('serves the same immutable-lifetime catalog used by the live MCP registry', async () => {
    const service = createRuntimeCapabilitiesService(getRuntimeCapabilityCatalog);
    const first = await service.find();
    const second = await service.find();

    expect(first).toBe(second);
    expect(first).toEqual(buildRegistry().runtimeCatalog);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'disco-mcp:disco_files_publish',
          exposure: 'agent-callable',
        }),
        expect.objectContaining({
          id: 'ui-only:schedules',
          exposure: 'ui-only',
        }),
      ])
    );
  });

  it('does not expose mutating service methods', () => {
    const service = createRuntimeCapabilitiesService(
      getRuntimeCapabilityCatalog
    ) as unknown as Record<string, unknown>;

    for (const method of ['create', 'update', 'patch', 'remove']) {
      expect(service[method]).toBeUndefined();
    }
  });
});
