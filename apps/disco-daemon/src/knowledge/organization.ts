import { extname } from 'node:path';
import type {
  KnowledgeEntry,
  KnowledgeMaterialType,
  KnowledgeNoteType,
  KnowledgeOrganization,
  KnowledgeProcessingFilter,
} from '@disco/core/types';

/** Format classification is independent of extraction/index success. */
export function materialType(entry: KnowledgeEntry): KnowledgeMaterialType {
  if (entry.kind !== 'document') return entry.kind;
  const names = [entry.title, ...(entry.attachments ?? []).map((file) => file.name)];
  if (
    entry.attachments?.some((file) => file.mimeType?.startsWith('image/')) ||
    names.some((name) => /\.(png|jpe?g|webp|gif|avif|heic|bmp|tiff?|svg)$/i.test(name))
  )
    return 'image';
  if (
    names.some((name) =>
      [
        '.md',
        '.txt',
        '.pdf',
        '.doc',
        '.docx',
        '.odt',
        '.rtf',
        '.csv',
        '.xlsx',
        '.xls',
        '.pptx',
        '.ppt',
        '.html',
        '.json',
        '.jsonl',
        '.yaml',
        '.yml',
      ].includes(extname(name).toLowerCase())
    )
  )
    return 'document';
  return 'file';
}

export function organization(entry: KnowledgeEntry): KnowledgeOrganization {
  return (
    entry.organization ?? {
      topic: '未分类',
      level: entry.kind === 'note' ? (entry.derivedFrom ? 'summary' : 'knowledge') : 'source',
      state: entry.humanEdited ? 'reviewed' : 'draft',
      ...(entry.derivedFrom ? { sourceEntryIds: [entry.derivedFrom.entryId] } : {}),
    }
  );
}

export function canSummarize(entry: KnowledgeEntry): boolean {
  return (
    !entry.historical &&
    entry.sourceVersion?.visibleMessages !== 0 &&
    entry.kind !== 'note' &&
    !entry.sourceId.includes(':variant:') &&
    (entry.kind === 'conversation' || entry.parseStatus === 'parsed')
  );
}

export function noteType(entry: KnowledgeEntry): KnowledgeNoteType | undefined {
  if (entry.kind !== 'note') return undefined;
  if (organization(entry).level === 'knowledge') return 'knowledge';
  return entry.summaryMode === 'structured_overview' ? 'overview' : 'summary';
}

export function retryDate(attempts: number, minimumMs = 0): string {
  return new Date(
    Date.now() + Math.max(minimumMs, Math.min(30 * 60_000, 30_000 * 2 ** Math.min(attempts - 1, 6)))
  ).toISOString();
}

export function hasProcessingIssue(
  entry: KnowledgeEntry,
  issue: KnowledgeProcessingFilter
): boolean {
  if (issue === 'index_error') return entry.indexStatus === 'error';
  if (issue === 'parse_error') return entry.kind !== 'note' && entry.parseStatus === 'error';
  if (issue === 'metadata_only')
    return entry.kind !== 'note' && entry.parseStatus === 'unsupported';
  return entry.kind === 'note'
    ? entry.generation?.state === 'failed'
    : !entry.summaryDisposition && Boolean(entry.summaryMessage);
}
