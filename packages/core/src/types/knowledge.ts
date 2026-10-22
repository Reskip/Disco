/** Identity must come from authenticated server context, never a request body. */
export interface KnowledgeOwner {
  tenantId: string;
  userId: string;
}

export type KnowledgeSource = 'disco' | 'codex' | 'manual';
export type KnowledgeKind = 'conversation' | 'document' | 'note';
export type KnowledgeIndexStatus = 'pending' | 'indexed' | 'error';
export type KnowledgeParseStatus = 'pending' | 'parsed' | 'unsupported' | 'error';

export interface KnowledgeSourceVersion {
  kind: 'codex-rollout';
  sha256: string;
  byteLength: number;
  recordCount: number;
  firstEventAt?: string;
  lastEventAt?: string;
  complete: boolean;
  malformedRecords: number;
}

export interface KnowledgeAttachment {
  id?: string;
  name: string;
  /** Relative to this owner's portable library. */
  relativePath?: string;
  sourceUrl?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface KnowledgeEntry {
  id: string;
  title: string;
  kind: KnowledgeKind;
  source: KnowledgeSource;
  sourceId: string;
  createdAt: string;
  updatedAt: string;
  humanEdited: boolean;
  relativePath: string;
  sizeBytes: number;
  indexStatus: KnowledgeIndexStatus;
  sourceUpdatedAt?: string;
  sourceUrl?: string;
  attachments?: KnowledgeAttachment[];
  snippet?: string;
  derivedFrom?: { entryId: string; contentHash: string };
  summaryContentHash?: string;
  sourceVersion?: KnowledgeSourceVersion;
  parseStatus?: KnowledgeParseStatus;
  parseMessage?: string;
}

export interface KnowledgeEntryDetail {
  entry: KnowledgeEntry;
  markdown: string;
  /** Used to prevent an indexing job from marking a newer edit as indexed. */
  contentHash: string;
}

export interface KnowledgeUploadResult extends KnowledgeEntryDetail {
  parsing?: { status: 'parsed' | 'unsupported' | 'error' | 'protected'; message?: string };
}

export interface KnowledgeSourceInput {
  source: KnowledgeSource;
  sourceId: string;
  title: string;
  kind: KnowledgeKind;
  markdown: string;
  /** Complete original transcript or record, encoded as JSONL. Never truncated. */
  rawContent?: string;
  sourceUpdatedAt?: string;
  sourceUrl?: string;
  attachments?: KnowledgeAttachment[];
  derivedFrom?: { entryId: string; contentHash: string };
  sourceVersion?: KnowledgeSourceVersion;
}

export interface KnowledgeListOptions {
  query?: string;
  kind?: KnowledgeKind;
  source?: KnowledgeSource;
  offset?: number;
  limit?: number;
}

export interface KnowledgeListResult {
  entries: KnowledgeEntry[];
  total: number;
}

export interface KnowledgeLibraryStatus {
  total: number;
  conversations: number;
  documents: number;
  notes: number;
  humanEdited: number;
  pendingIndex: number;
  deleted: number;
  totalBytes: number;
  lastReconciledAt?: string;
  sync?: {
    state: 'idle' | 'running' | 'error';
    message?: string;
    lastCompletedAt?: string;
    processed?: number;
  };
  engine?: { status: 'ready' | 'unavailable' | 'disabled'; message?: string };
}
