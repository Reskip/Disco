import { describe, expect, it } from 'vitest';
import {
  codexModelDisplayName,
  fallbackCodexModelCatalog,
  getCodexCatalogSelectionError,
  getCodexReplacementModel,
  parseCodexModelCatalog,
} from './codex-catalog';

const rows = [
  {
    id: 'row-id',
    model: 'new-model',
    displayName: 'New model (Recommended)',
    isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }],
    defaultReasoningEffort: 'medium',
  },
  { model: 'old-hidden', hidden: true, upgrade: 'new-model' },
];

describe('Codex runtime catalog compatibility', () => {
  it('uses executable model IDs, keeps hidden entries for compatibility and strips badges', () => {
    const catalog = parseCodexModelCatalog(rows);
    expect(catalog.default).toBe('new-model');
    expect(catalog.models[0]).toMatchObject({
      id: 'new-model',
      displayName: 'New model',
      supportedReasoningEfforts: ['medium', 'high'],
    });
    expect(
      getCodexCatalogSelectionError(catalog, { model: 'old-hidden', mode: 'alias' })
    ).toBeUndefined();
    expect(getCodexReplacementModel(catalog, 'old-hidden')?.id).toBe('new-model');
    expect(codexModelDisplayName('Test（账号相关） (default)')).toBe('Test');
  });
  it('preserves removed defaults and exact IDs; stale discovery cannot invalidate anything', () => {
    const catalog = parseCodexModelCatalog(rows);
    const selection = { model: 'removed-model', mode: 'alias', effort: 'max' as const };
    expect(getCodexCatalogSelectionError(catalog, selection)).toContain('原设置已保留');
    expect(selection.model).toBe('removed-model');
    expect(getCodexCatalogSelectionError(catalog, { ...selection, mode: 'exact' })).toBeUndefined();
    expect(
      getCodexCatalogSelectionError({ ...catalog, source: 'cached' }, selection)
    ).toBeUndefined();
    expect(getCodexCatalogSelectionError(fallbackCodexModelCatalog(), selection)).toBeUndefined();
  });
  it('checks effort against the selected model and leaves compatible settings intact', () => {
    const catalog = parseCodexModelCatalog(rows);
    expect(getCodexCatalogSelectionError(catalog, { model: 'new-model', effort: 'max' })).toContain(
      '不支持当前思考深度'
    );
    expect(
      getCodexCatalogSelectionError(catalog, { model: 'new-model', effort: 'high' })
    ).toBeUndefined();
  });
  it('rejects empty or malformed responses instead of treating every model as removed', () => {
    expect(() => parseCodexModelCatalog([])).toThrow();
    expect(() => parseCodexModelCatalog([...rows, {}])).toThrow();
    expect(() => parseCodexModelCatalog([{ model: 'hidden', hidden: true }])).toThrow();
  });
});
