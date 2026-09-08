import type { DiscoConfig } from '@disco/core/config';
import type { DeepReadonly } from '@disco/core/types';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { deepFreeze, deepFreezeClone } from './deep-freeze.js';

describe('deepFreeze', () => {
  it('recursively freezes the effective configuration snapshot', () => {
    const frozen = deepFreeze<DiscoConfig>({ execution: { unix_user_mode: 'sandbox' } });
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.execution)).toBe(true);
    expect(() => {
      (frozen.execution as { unix_user_mode?: string }).unix_user_mode = 'simple';
    }).toThrow();
  });

  it('preserves deep-readonly typing through optional configuration sections', () => {
    const frozen = deepFreeze<DiscoConfig>({ execution: { unix_user_mode: 'sandbox' } });
    expectTypeOf(frozen).toEqualTypeOf<DeepReadonly<DiscoConfig>>();
  });

  it('does not freeze nested objects owned by the caller', () => {
    const input: DiscoConfig = { execution: { unix_user_mode: 'sandbox' } };
    const frozen = deepFreezeClone(input);
    expect(frozen).not.toBe(input);
    expect(frozen.execution).not.toBe(input.execution);
    expect(Object.isFrozen(frozen.execution)).toBe(true);
    expect(Object.isFrozen(input.execution)).toBe(false);
  });
});
