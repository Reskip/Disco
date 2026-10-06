import { describe, expect, it } from 'vitest';
import {
  CODEX_MINI_MODEL,
  CODEX_MODEL_METADATA,
  CODEX_MODEL_REGISTRY,
  DEFAULT_CODEX_MODEL,
  formatUnsupportedDiscoCodexModelMessage,
  getCodexModelLifecycle,
  getCodexModelSelectionError,
  isUnsupportedDiscoCodexModel,
} from './codex.js';

describe('Codex model registry', () => {
  it('keeps current defaults on supported Codex models', () => {
    expect(DEFAULT_CODEX_MODEL).toBe('gpt-5.6-sol');
    expect(CODEX_MINI_MODEL).toBe('gpt-5.6-terra');
  });

  it('surfaces supported and provider-dependent models newest-first', () => {
    const selectableIds = Object.keys(CODEX_MODEL_METADATA);

    expect(selectableIds.slice(0, 4)).toEqual([
      'gpt-6-astra',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]);
    expect(CODEX_MODEL_METADATA['gpt-6-astra'].availability).toBe('provider-dependent');
    expect(selectableIds).toContain('gpt-5.5');
    expect(selectableIds).toContain('gpt-5.4-mini');
    expect(selectableIds).toContain('gpt-5.4');
    expect(selectableIds).not.toContain('gpt-5-codex');
    expect(CODEX_MODEL_METADATA['gpt-5.5'].availability).toBe('provider-dependent');
  });

  it('keeps legacy aliases in the lifecycle registry for diagnostics', () => {
    expect(CODEX_MODEL_REGISTRY['gpt-5-codex']).toMatchObject({
      selectable: false,
      availability: 'unsupported',
      replacement: 'gpt-5.6-sol',
    });
  });

  it('matches exact and dated legacy aliases', () => {
    expect(getCodexModelLifecycle('gpt-5-codex')).toBe(CODEX_MODEL_REGISTRY['gpt-5-codex']);
    expect(getCodexModelLifecycle('gpt-5-codex-2026-01-01')).toBe(
      CODEX_MODEL_REGISTRY['gpt-5-codex']
    );
    expect(getCodexModelLifecycle('gpt-5-codex-mini-2026-01-01')).toBe(
      CODEX_MODEL_REGISTRY['gpt-5-codex-mini']
    );
    expect(getCodexModelLifecycle('gpt-5.4-mini-2026-01-01')).toBe(
      CODEX_MODEL_REGISTRY['gpt-5.4-mini']
    );
    expect(getCodexModelLifecycle('gpt-5.6-luna-2026-07-09')).toBe(
      CODEX_MODEL_REGISTRY['gpt-5.6-luna']
    );
    expect(getCodexModelLifecycle('gpt-6-astra-2026-09-05')).toBe(
      CODEX_MODEL_REGISTRY['gpt-6-astra']
    );
  });

  it('flags only known unsupported Disco Codex aliases', () => {
    expect(isUnsupportedDiscoCodexModel('gpt-5-codex')).toBe(true);
    expect(isUnsupportedDiscoCodexModel('gpt-5-codex-mini')).toBe(true);
    expect(isUnsupportedDiscoCodexModel('gpt-5.6-sol')).toBe(false);
    expect(isUnsupportedDiscoCodexModel('internal-model-v1')).toBe(false);
  });

  it('formats a user-actionable unsupported-model message', () => {
    const message = formatUnsupportedDiscoCodexModelMessage('gpt-5-codex');

    expect(message).toContain('gpt-5-codex');
    expect(message).toContain('gpt-5.6-sol');
    expect(message).toContain('user defaults');
    expect(message).toContain('omit modelConfig');
  });

  it('does not reject provider-owned IDs using a stale built-in registry', () => {
    for (const model of [
      'brand-new-model',
      'gpt-5-codex',
      'GPT-5.6-SOL',
      'gpt-5.6-sol-2026-07-09',
    ]) {
      expect(getCodexModelSelectionError({ mode: 'alias', model })).toBeUndefined();
      expect(getCodexModelSelectionError({ mode: 'exact', model })).toBeUndefined();
    }
  });
});
