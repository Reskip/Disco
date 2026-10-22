/** Identity must come from authenticated server context, never a request body. */
export interface KnowledgeOwner {
  tenantId: string;
  userId: string;
}

export type KnowledgeSource = 'disco' | 'codex' | 'manual';
export type KnowledgeKind = 'conversation' | 'document' | 'note';
export type KnowledgeIndexStatus = 'pending' | 'indexed' | 'error';
export type KnowledgeParseStatus = 'pending' | 'parsed' | 'unsupported' | 'error';
export type KnowledgeMaterialType = 'conversation' | 'image' | 'document' | 'file' | 'note';
export type KnowledgeNoteType = 'knowledge' | 'summary' | 'overview';
export type KnowledgeProcessingFilter =
  | 'index_error'
  | 'parse_error'
  | 'metadata_only'
  | 'summary_error';
export interface KnowledgeOrganization {
  topic: string;
  summary?: string;
  level: 'source' | 'summary' | 'knowledge';
  state: 'draft' | 'reviewed';
  tags?: string[];
  sourceEntryIds?: string[];
}
export interface KnowledgeSummaryProgress {
  phase: 'queued' | 'waiting_model' | 'processing';
  stage: 'map' | 'reduce';
  completed: number;
  total: number;
  requestStartedAt?: string;
  stageLevel?: number;
}
export interface KnowledgeGeneration {
  state: 'queued' | 'running' | 'failed' | 'complete';
  message?: string;
  attempts?: number;
  retryAt?: string;
  requestedTitle?: string;
  progress?: KnowledgeSummaryProgress;
  lastAttemptAt?: string;
}

export interface KnowledgeSourceVersion {
  kind: 'codex-rollout' | 'codex-sqlite';
  sha256: string;
  byteLength: number;
  recordCount: number;
  firstEventAt?: string;
  lastEventAt?: string;
  complete: boolean;
  malformedRecords: number;
  /** Stable per-thread SQLite projection watermark, not the whole database mtime. */
  signature?: string;
  /** Nonempty user/assistant messages after filtering injected app context. */
  visibleMessages?: number;
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

/** The exact readable source version used when a note was created or generated. */
export interface KnowledgeSourceReference {
  id: string;
  title: string;
  contentHash: string;
}

export type KnowledgeSourceRevisionStatus = 'current' | 'changed' | 'deleted' | 'unknown';

/** Server-attested local reading projection, valid only for this complete Markdown hash. */
export interface KnowledgeParseProjection {
  kind: 'geospatial';
  version: 1;
  contentHash: string;
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
  materialType?: KnowledgeMaterialType;
  organization?: KnowledgeOrganization;
  generation?: KnowledgeGeneration;
  indexMessage?: string;
  indexAttempts?: number;
  indexRetryAt?: string;
  summaryMessage?: string;
  summaryAttempts?: number;
  summaryRetryAt?: string;
  summaryProgress?: KnowledgeSummaryProgress;
  summaryAttemptedAt?: string;
  summaryDisposition?: 'summarized' | 'archive_only';
  summaryReason?: string;
  /** Distinguishes a locally computed file inventory from model-based synthesis. */
  summaryMode?: 'structured_overview' | 'model';
  /** Local overview renderer/classifier version; old automatic drafts can be rebuilt. */
  summaryFormatVersion?: number;
  /** Superseded import copies remain readable/exportable, outside the normal catalog. */
  historical?: boolean;
  sourceUpdatedAt?: string;
  sourceUrl?: string;
  attachments?: KnowledgeAttachment[];
  snippet?: string;
  /** Transient catalog body match: UTF-16 snippet start in this exact content version. */
  searchMatch?: { offset: number; contentHash: string };
  derivedFrom?: { entryId: string; contentHash: string };
  sourceReferences?: KnowledgeSourceReference[];
  summaryContentHash?: string;
  sourceVersion?: KnowledgeSourceVersion;
  titleProjectionVersion?: number;
  parseStatus?: KnowledgeParseStatus;
  parseMessage?: string;
  parseAttempts?: number;
  parseRetryAt?: string;
  parseRetryable?: boolean;
  parseProjection?: KnowledgeParseProjection;
}

export interface KnowledgeEntryDetail {
  /** Optional reading window. Omitted when returning the complete editable Markdown. */
  page?: { offset: number; totalChars: number; nextOffset: number | null; hasMore: boolean };
  entry: KnowledgeEntry;
  markdown: string;
  /** Used to prevent an indexing job from marking a newer edit as indexed. */
  contentHash: string;
  sources?: Array<{
    id: string;
    title: string;
    kind?: KnowledgeKind;
    available: boolean;
    /** Older servers may omit this field; missing provenance is never assumed current. */
    revisionStatus?: KnowledgeSourceRevisionStatus;
  }>;
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
  sourceReferences?: KnowledgeSourceReference[];
  sourceVersion?: KnowledgeSourceVersion;
  titleProjectionVersion?: number;
  organization?: KnowledgeOrganization;
  generation?: KnowledgeGeneration;
  summaryMode?: 'structured_overview' | 'model';
  summaryFormatVersion?: number;
  /** Server-only: automatic drafts remain writable until a human edits them. */
  automated?: boolean;
  /** Server-only commit guard for summaries generated from these exact source versions. */
  expectedSources?: Array<{ id: string; contentHash: string }>;
  /** Server-only extraction commit guard against a replaced original attachment. */
  expectedAttachmentId?: string;
}

export interface KnowledgeListOptions {
  query?: string;
  kind?: KnowledgeKind;
  source?: KnowledgeSource;
  materialType?: KnowledgeMaterialType;
  level?: KnowledgeOrganization['level'];
  topic?: string;
  reviewState?: KnowledgeOrganization['state'];
  includeHistory?: boolean;
  noteType?: KnowledgeNoteType;
  processing?: KnowledgeProcessingFilter;
  sort?: 'updated' | 'curated';
  offset?: number;
  limit?: number;
}

export interface KnowledgeListResult {
  entries: KnowledgeEntry[];
  total: number;
}

export interface KnowledgeCatalogResult extends KnowledgeListResult {
  status: KnowledgeLibraryStatus;
  overview: KnowledgeOverview;
}

export interface KnowledgeOverview {
  topics: Array<{ topic: string; count: number }>;
  noteTopics?: Array<{ topic: string; count: number }>;
  counts: Record<KnowledgeOrganization['level'], number>;
  materials: Record<KnowledgeMaterialType, number>;
  issues?: {
    sources: {
      indexErrors: number;
      parseErrors: number;
      metadataOnly: number;
      summaryErrors: number;
    };
    notes: { indexErrors: number; summaryErrors: number };
  };
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
    intervalSeconds?: number;
    nextRunAt?: string;
  };
  processing?: {
    index: {
      pending: number;
      indexed: number;
      failed: number;
      unsupported: number;
      active?: string;
      message?: string;
    };
    summary: {
      pending: number;
      completed: number;
      failed: number;
      archivedOnly?: number;
      progress?: KnowledgeSummaryProgress;
      active?: string;
      message?: string;
    };
  };
  engine?: { status: 'ready' | 'unavailable' | 'disabled'; message?: string };
}
