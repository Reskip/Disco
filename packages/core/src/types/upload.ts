import type { AgentID, SessionID, UserID } from './id';
import type { TenantID } from './tenant';

/** Opaque identifier for bytes held at the ingress (boundary B) staging layer. */
export type UploadRef = string & { readonly __brand: 'UploadRef' };

export type UploadProvenance = 'browser';
export type UploadStatus = 'pending' | 'active' | 'deleting';

export interface UploadOwner {
  tenantId: TenantID;
  sessionId: SessionID;
  createdBy: UserID;
  agentId: AgentID | null;
}

export interface UploadMetadata {
  ref: UploadRef;
  name: string;
  mimeType: string;
  size: number;
  /** Optional SHA-256 digest used to make explicit Agent publication idempotent. */
  checksum?: string | null;
  createdAt: string;
  expiresAt: string | null;
  provenance: UploadProvenance;
}

/** Runtime-neutral shape used to describe staged uploads in agent prompts. */
export interface UploadPromptAttachment {
  ref: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** Authenticated image preview embedded inside a completed tool result. */
export interface ToolImageContentBlock {
  type: 'image';
  filename: string;
  mime_type: string;
  available: boolean;
  upload_ref?: string;
  size?: number;
  unavailable_reason?: string;
}

export function isToolImageContentBlock(value: unknown): value is ToolImageContentBlock {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type !== 'image' ||
    typeof candidate.filename !== 'string' ||
    typeof candidate.mime_type !== 'string' ||
    typeof candidate.available !== 'boolean'
  ) {
    return false;
  }
  if (candidate.available && typeof candidate.upload_ref !== 'string') return false;
  if (
    candidate.size !== undefined &&
    (typeof candidate.size !== 'number' || !Number.isFinite(candidate.size) || candidate.size < 0)
  ) {
    return false;
  }
  return (
    candidate.unavailable_reason === undefined || typeof candidate.unavailable_reason === 'string'
  );
}

/**
 * Keep a user-visible upload name safe for a single filesystem path segment
 * without discarding Unicode. This is shared by storage and executor
 * materialization so a filename cannot change between ingress and runtime.
 */
export function sanitizeUploadFilename(value: string): string {
  const basename = value.split(/[\\/]/u).at(-1) ?? '';
  const clean = [
    ...basename
      .normalize('NFC')
      .replace(/\.\./g, '_')
      .replace(/[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/gu, '_')
      .replace(/[. ]+$/g, ''),
  ]
    .slice(0, 200)
    .join('');
  return clean || 'upload';
}

export type PublishedFileDisplayType = 'image' | 'pdf' | 'audio' | 'video' | 'file';

const PUBLISHED_FILE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/tsx',
  '.py': 'text/x-python',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
};

export function inferPublishedFileMimeType(filename: string): string {
  const basename = filename.split(/[\\/]/u).at(-1) ?? filename;
  const dot = basename.lastIndexOf('.');
  const extension = dot >= 0 ? basename.slice(dot).toLowerCase() : '';
  return PUBLISHED_FILE_MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

/** Stable, storage-neutral result returned by Disco's explicit publish method. */
export interface DiscoPublishedFile extends UploadPromptAttachment {
  fileId: string;
  sessionId: SessionID;
  userId: UserID;
  displayType: PublishedFileDisplayType;
  storage: {
    kind: 'disco-upload';
    ref: string;
    url: string;
  };
}

export interface DiscoFilePublication {
  type: 'disco_file_publication';
  published: true;
  sessionId: SessionID;
  userId: UserID;
  files: DiscoPublishedFile[];
}

export function classifyPublishedFileDisplayType(mimeType: string): PublishedFileDisplayType {
  const normalized = mimeType.trim().toLowerCase();
  if (normalized.startsWith('image/')) return 'image';
  if (normalized === 'application/pdf') return 'pdf';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('video/')) return 'video';
  return 'file';
}

export interface ParsedUploadPromptAttachment {
  ref: string;
  filename: string;
  mimeType: string;
  sizeLabel: string;
}

export interface ParsedUploadAttachmentPrompt {
  attachments: ParsedUploadPromptAttachment[];
  visibleText: string;
}

export const UPLOAD_VIRTUAL_URL_PREFIX = 'https://disco.live/_uploads/';
/**
 * Transport-only heading for inbound files already staged by Disco.
 * The executor materializes these references before Codex receives the turn.
 */
export const UPLOAD_ATTACHMENT_HEADING = 'Attached files:';

export const UPLOAD_REF_PATTERN =
  'upl_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

export function isUploadRef(value: string): boolean {
  return new RegExp(`^${UPLOAD_REF_PATTERN}$`, 'iu').test(value);
}
const UPLOAD_ATTACHMENT_LINE = new RegExp(
  `^- \\[(.+?)\\]\\(${UPLOAD_VIRTUAL_URL_PREFIX.replaceAll('.', '\\.')}(${UPLOAD_REF_PATTERN})\\) \\(([^,]+), (.+)\\)$`,
  'i'
);

/** Public, resolved ingress limits shared by daemon and browser clients. */
export interface UploadIngressPolicy {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
}

export function formatUploadBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

export function buildUploadAttachmentPrompt(
  text: string,
  attachments: readonly UploadPromptAttachment[]
): string {
  const trimmedText = text.trim();
  if (attachments.length === 0) return trimmedText;
  const attachmentBlock = [
    UPLOAD_ATTACHMENT_HEADING,
    ...attachments.map(
      ({ ref, filename, mimeType, size }) =>
        `- [${filename}](${UPLOAD_VIRTUAL_URL_PREFIX}${ref}) (${mimeType}, ${formatUploadBytes(size)})`
    ),
  ].join('\n');
  if (trimmedText.startsWith('/')) return `${trimmedText}\n\n${attachmentBlock}`;
  return trimmedText ? `${attachmentBlock}\n\n${trimmedText}` : attachmentBlock;
}

/**
 * Parse the opaque upload block embedded in a persisted prompt.
 *
 * The parser is shared by the browser renderer and executor so those two
 * boundaries cannot drift: the browser hides the transport-only block while
 * the executor turns the same refs into real workspace files.
 */
export function parseUploadAttachmentPrompt(content: string): ParsedUploadAttachmentPrompt {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const attachments: ParsedUploadPromptAttachment[] = [];
  const visibleLines: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== UPLOAD_ATTACHMENT_HEADING) {
      visibleLines.push(lines[index]);
      continue;
    }

    const block: ParsedUploadPromptAttachment[] = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const match = lines[cursor].trim().match(UPLOAD_ATTACHMENT_LINE);
      if (!match) break;
      block.push({
        filename: match[1],
        ref: match[2],
        mimeType: match[3].trim(),
        sizeLabel: match[4].trim(),
      });
      cursor += 1;
    }

    // Preserve malformed blocks verbatim. Silently hiding user-authored text
    // would be worse than rendering a broken transport preamble.
    if (block.length === 0) {
      visibleLines.push(lines[index]);
      continue;
    }

    attachments.push(...block);
    index = cursor - 1;
  }

  return { attachments, visibleText: visibleLines.join('\n').trim() };
}

/** Persisted logical upload metadata. Storage keys are deliberately excluded. */
export interface Upload {
  ref: UploadRef;
  tenantId: TenantID;
  createdBy: UserID;
  sessionId: SessionID;
  agentId: AgentID | null;
  originalName: string;
  displayName: string;
  mimeType: string;
  size: number;
  checksum: string | null;
  status: UploadStatus;
  provenance: UploadProvenance;
  createdAt: string;
  expiresAt: string | null;
}

export interface UploadStageInput {
  owner: UploadOwner;
  name: string;
  mimeType: string;
  provenance: UploadProvenance;
  body: NodeJS.ReadableStream;
  sizeHint?: number;
  /** Precomputed SHA-256 digest when the caller owns a stable source file. */
  checksum?: string;
  ttlMs?: number;
}

export interface UploadReadInput {
  tenantId: TenantID;
  sessionId: SessionID;
  createdBy: UserID;
  agentId: AgentID | null;
  ref: UploadRef;
}

/**
 * Storage-neutral port for temporary ingress bytes. Implementations must
 * authorize every operation against owner, never disclose physical keys, and
 * enforce limits while streaming (size hints are not authoritative).
 */
export interface UploadStagingStore {
  stage(input: UploadStageInput): Promise<UploadMetadata>;
  inspect(input: UploadReadInput): Promise<UploadMetadata>;
  read(
    input: UploadReadInput & { offset?: number; length?: number }
  ): Promise<NodeJS.ReadableStream>;
  consume(input: UploadReadInput): Promise<void>;
  delete(input: UploadReadInput): Promise<void>;
  cleanupExpired(owner: Pick<UploadOwner, 'tenantId'>, now?: Date): Promise<number>;
}
