import { extname } from 'node:path';
import type {
  KnowledgeEntry,
  KnowledgeMaterialType,
  KnowledgeOrganization,
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

export function retryDate(attempts: number, minimumMs = 0): string {
  return new Date(
    Date.now() + Math.max(minimumMs, Math.min(30 * 60_000, 30_000 * 2 ** Math.min(attempts - 1, 6)))
  ).toISOString();
}
