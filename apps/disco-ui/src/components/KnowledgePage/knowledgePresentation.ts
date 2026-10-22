import type { KnowledgeEntry } from '@disco/core/types';

export const SOURCE_LABELS: Record<KnowledgeEntry['source'], string> = {
  disco: 'Disco 会话',
  codex: '宿主机 Codex',
  manual: '手动添加',
};
export const KIND_LABELS: Record<KnowledgeEntry['kind'], string> = {
  conversation: '会话',
  document: '文档',
  note: '笔记',
};
export const INDEX_LABELS: Record<KnowledgeEntry['indexStatus'], string> = {
  pending: '待索引',
  indexed: '已索引',
  error: '索引异常',
};

export const PARSE_LABELS: Record<NonNullable<KnowledgeEntry['parseStatus']>, string> = {
  pending: '等待解析正文',
  parsed: '正文已解析',
  unsupported: '暂不支持解析 · 原件已保留',
  error: '正文解析失败 · 原件已保留',
};

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : '加载失败，请稍后重试';
}

export function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}

export function safeSourceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Source metadata is imported data. Only ordinary web links may navigate the browser.
  if (/^https?:\/\//iu.test(value) || /^\/(?!\/)/u.test(value)) return value;
  return undefined;
}
