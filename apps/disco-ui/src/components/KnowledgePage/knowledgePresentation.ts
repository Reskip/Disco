import type {
  KnowledgeEntry,
  KnowledgeEntryDetail,
  KnowledgeGeneration,
  KnowledgeMaterialType,
  KnowledgeOrganization,
  KnowledgeSummaryProgress,
} from '@disco/core/types';

/** Hide only a complete server-attested machine marker in the reading view. */
export function sourceReadingText(detail: KnowledgeEntryDetail): string {
  const projection = detail.entry.parseProjection;
  if (
    detail.entry.humanEdited ||
    projection?.kind !== 'geospatial' ||
    projection.version !== 1 ||
    projection.contentHash !== detail.contentHash
  )
    return detail.markdown;
  return detail.markdown.replace(
    /^<!-- disco-geospatial-projection:(\{[^\r\n]+\}) -->\r?$(?:\n)?/m,
    (line, metadata: string) => {
      try {
        const value = JSON.parse(metadata);
        return value.version === 1 &&
          ['gpx', 'kml'].includes(value.format) &&
          /^[a-f0-9]{64}$/.test(value.sha256) &&
          value.counts &&
          typeof value.counts === 'object' &&
          !Array.isArray(value.counts)
          ? ''
          : line;
      } catch {
        return line;
      }
    }
  );
}

export const MATERIAL_LABELS: Record<KnowledgeMaterialType, string> = {
  conversation: '会话',
  document: '文档',
  image: '图片',
  file: '其它文件',
  note: '笔记',
};
export const LEVEL_LABELS: Record<KnowledgeOrganization['level'], string> = {
  source: '原始资料',
  summary: '摘要',
  knowledge: '专题知识',
};
export const GENERATION_LABELS: Record<KnowledgeGeneration['state'], string> = {
  queued: '等待自动整理',
  running: '正在自动整理',
  failed: '整理失败，等待重试',
  complete: '整理完成',
};
export function entryOrganization(entry?: KnowledgeEntry): KnowledgeOrganization {
  return (
    entry?.organization ?? {
      topic: '未分类',
      level: entry?.kind === 'note' ? (entry.derivedFrom ? 'summary' : 'knowledge') : 'source',
      state: entry?.humanEdited ? 'reviewed' : 'draft',
      sourceEntryIds: entry?.derivedFrom ? [entry.derivedFrom.entryId] : undefined,
    }
  );
}

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

export function hasSummaryFailure(entry: KnowledgeEntry): boolean {
  return entry.kind === 'note'
    ? entry.generation?.state === 'failed'
    : !entry.summaryDisposition && Boolean(entry.summaryMessage);
}

export const PROCESSING_LABELS = {
  index_error: '索引失败',
  parse_error: '正文解析失败',
  metadata_only: '仅文件信息可检索',
  summary_error: '整理失败',
};

export const PROCESSING_DESCRIPTIONS = {
  index_error: '原始内容仍可阅读和下载，后台会自动重试建立索引。',
  parse_error: '原件已保留。打开资料可查看解析失败原因，仍可下载原件或人工整理。',
  metadata_only: '这些原件目前只可按文件信息检索，尚未识别正文或图片内容。原件仍可下载。',
  summary_error: '自动整理尚未成功，后台会重试。也可以选择资料，人工整理成笔记。',
};

export function formatSummaryProgress(progress?: KnowledgeSummaryProgress): string | undefined {
  if (!progress) return undefined;
  const total = Math.max(0, Math.floor(progress.total));
  const completed = Math.min(total, Math.max(0, Math.floor(progress.completed)));
  const reduced = progress.stage === 'reduce';
  const completedText =
    completed > 0 ? `已完成 ${completed}/${total} ${reduced ? '组归并' : '段'}` : '';
  const activity =
    progress.phase === 'queued'
      ? '等待后台处理'
      : progress.phase === 'waiting_model'
        ? '等待模型响应'
        : completed === total && total > 0
          ? '正在保存整理结果'
          : completed > 0
            ? '正在处理后续内容'
            : reduced
              ? '正在汇总分段结果'
              : '正在准备资料';
  return [
    reduced ? '归并整理阶段' : '',
    completedText,
    activity,
    !reduced && completed === 0 && total > 1 ? `共 ${total} 段` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function safeSourceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Source metadata is imported data. Only ordinary web links may navigate the browser.
  if (/^https?:\/\//iu.test(value) || /^\/(?!\/)/u.test(value)) return value;
  return undefined;
}
