import { describe, expect, it } from 'vitest';
import {
  assertValidRuntimeCapabilities,
  buildRuntimeCapabilityCatalog,
  CODEX_NATIVE_RUNTIME_CAPABILITIES,
  DISCO_UI_ONLY_RUNTIME_CAPABILITIES,
  type RuntimeCapabilityDefinition,
} from './runtime-capabilities.js';

describe('runtime capability catalog', () => {
  it('builds a deterministic provider-qualified catalog', () => {
    const first = buildRuntimeCapabilityCatalog(
      CODEX_NATIVE_RUNTIME_CAPABILITIES,
      DISCO_UI_ONLY_RUNTIME_CAPABILITIES
    );
    const second = buildRuntimeCapabilityCatalog(
      [...DISCO_UI_ONLY_RUNTIME_CAPABILITIES].reverse(),
      [...CODEX_NATIVE_RUNTIME_CAPABILITIES].reverse()
    );

    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toEqual(first);
    expect(first.entries.find(({ id }) => id === 'codex-native:image-generation')).toMatchObject({
      provider: 'codex-native',
      exposure: 'runtime-event',
      outputKinds: ['file', 'image', 'state'],
    });
    expect(first.entries.find(({ id }) => id === 'ui-only:schedules')).toMatchObject({
      provider: 'ui-only',
      exposure: 'ui-only',
    });
  });

  it('rejects duplicate and malformed callable capabilities', () => {
    const callable: RuntimeCapabilityDefinition = {
      id: 'disco-mcp:test',
      name: 'disco_test',
      provider: 'disco-mcp',
      kind: 'method',
      exposure: 'agent-callable',
      description: 'Test method',
      audiences: ['agent'],
      ownership: 'current-session',
      outputKinds: ['text'],
      lifecycle: 'runtime',
      dependencies: [],
    };

    expect(() => assertValidRuntimeCapabilities([callable])).toThrow(/object input schema/u);
    expect(() =>
      assertValidRuntimeCapabilities([
        { ...callable, inputSchema: { type: 'object' } },
        { ...callable, inputSchema: { type: 'object' } },
      ])
    ).toThrow(/duplicate capability id/u);
  });
});
