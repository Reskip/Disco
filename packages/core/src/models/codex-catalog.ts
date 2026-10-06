import type { CodexModelCatalog, CodexModelOption, EffortLevel } from '../types';
import { CODEX_MODEL_METADATA, DEFAULT_CODEX_MODEL } from './codex';

const EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function codexModelDisplayName(name: string): string {
  return name
    .replace(/\s*[（(](?:recommended|default|account-dependent|推荐|默认|账号相关)[）)]/gi, '')
    .trim();
}

export function fallbackCodexModelCatalog(): CodexModelCatalog {
  return {
    source: 'static',
    default: DEFAULT_CODEX_MODEL,
    models: Object.entries(CODEX_MODEL_METADATA).map(([id, model]) => ({
      id,
      displayName: codexModelDisplayName(model.name),
      description: model.description,
      hidden: false,
      isDefault: id === DEFAULT_CODEX_MODEL,
    })),
  };
}

/** Reject partial/malformed catalogs; never turn a discovery error into removals. */
export function parseCodexModelCatalog(rows: unknown[]): CodexModelCatalog {
  const models = new Map<string, CodexModelOption>();
  for (const value of rows) {
    if (!value || typeof value !== 'object') throw new Error('Invalid Codex model metadata');
    const row = value as Record<string, unknown>;
    const id = typeof row.model === 'string' ? row.model : row.id;
    if (typeof id !== 'string' || !id.trim()) throw new Error('Missing Codex model id');
    const efforts = Array.isArray(row.supportedReasoningEfforts)
      ? row.supportedReasoningEfforts.flatMap((value) => {
          const effort = value && typeof value === 'object' ? value.reasoningEffort : value;
          return EFFORTS.includes(effort) ? [effort as EffortLevel] : [];
        })
      : undefined;
    models.set(id, {
      id,
      displayName: codexModelDisplayName(
        typeof row.displayName === 'string' ? row.displayName : id
      ),
      ...(typeof row.description === 'string' ? { description: row.description } : {}),
      hidden: row.hidden === true,
      isDefault: row.isDefault === true,
      ...(efforts?.length ? { supportedReasoningEfforts: efforts } : {}),
      ...(EFFORTS.includes(row.defaultReasoningEffort as EffortLevel)
        ? { defaultReasoningEffort: row.defaultReasoningEffort as EffortLevel }
        : {}),
      ...(typeof row.upgrade === 'string' ? { upgrade: row.upgrade } : {}),
    });
  }
  const visible = [...models.values()].filter((model) => !model.hidden);
  if (!visible.length) throw new Error('Empty Codex model catalog');
  return {
    source: 'dynamic',
    models: [...models.values()],
    default: (visible.find((model) => model.isDefault) ?? visible[0]).id,
    fetchedAt: new Date().toISOString(),
  };
}

export function getCodexCatalogSelectionError(
  catalog: CodexModelCatalog | undefined,
  selection: { model?: string; mode?: string; effort?: EffortLevel } | null | undefined
): string | undefined {
  if (catalog?.source !== 'dynamic' || !selection?.model) return undefined;
  const model = catalog.models.find((model) => model.id === selection.model);
  // Exact/pinned provider IDs may legitimately be absent from model/list.
  if (!model && selection.mode !== 'exact') {
    return `当前 Codex 列表已不再提供 ${selection.model}。原设置已保留，请选择其他模型，或锁定具体版本后由 Codex 验证。`;
  }
  if (
    model?.supportedReasoningEfforts?.length &&
    selection.effort &&
    !model.supportedReasoningEfforts.includes(selection.effort)
  ) {
    return `${selection.model} 不支持当前思考深度 ${selection.effort}。原设置已保留，请选择该模型支持的思考深度。`;
  }
  return undefined;
}

export function getCodexReplacementModel(
  catalog: CodexModelCatalog,
  modelId?: string
): CodexModelOption | undefined {
  const previous = catalog.models.find((model) => model.id === modelId);
  const visible = catalog.models.filter((model) => !model.hidden);
  return (
    visible.find((model) => model.id === previous?.upgrade) ??
    visible.find((model) => model.id === modelId) ??
    visible.find((model) => model.id === catalog.default) ??
    visible[0]
  );
}
