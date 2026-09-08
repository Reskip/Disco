/**
 * Upload middleware using multer for file upload handling
 *
 * Streams multipart ingress into the configured tenant/session staging store.
 */

import path from 'node:path';
import { Transform } from 'node:stream';
import { getTenantDataRoot } from '@disco/core/config';
import type {
  SessionID,
  TenantID,
  UploadIngressPolicy,
  UploadMetadata,
  UploadRef,
  UploadStagingStore,
} from '@disco/core/types';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';

/**
 * MIME types accepted by external gateway ingestion.
 *
 * Browser composer uploads intentionally do not use this set. Gateways keep a
 * narrow policy because their files arrive without an interactive local user.
 *
 * If you need to add a new type, prefer the most specific MIME possible.
 */
export const ALLOWED_UPLOAD_MIME_TYPES: ReadonlySet<string> = new Set([
  // Images
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  // NOTE: image/svg+xml is intentionally NOT allowed — SVGs can carry script.
  // Text / docs
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/pdf',
  // Office-style
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // Archives commonly used to ship logs/artifacts
  'application/zip',
  'application/gzip',
  'application/x-tar',
]);

/** Max size of a single uploaded file (bytes). */
export const MAX_UPLOAD_FILE_SIZE = Number.MAX_SAFE_INTEGER;
/** Max number of files in a single multipart request. */
export const MAX_UPLOAD_FILES_PER_REQUEST = 10;
/** Max combined size of all files in a single request (bytes). */
export const MAX_UPLOAD_TOTAL_SIZE = Number.MAX_SAFE_INTEGER;

let uploadLimits: UploadIngressPolicy = {
  maxFileBytes: MAX_UPLOAD_FILE_SIZE,
  maxTotalBytes: MAX_UPLOAD_TOTAL_SIZE,
  maxFiles: MAX_UPLOAD_FILES_PER_REQUEST,
};

/** Process-wide ingress policy, configured once alongside the staging store. */
export function configureUploadLimits(maxFileBytes: number): void {
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
    throw new Error('uploads.max_file_size_mb must resolve to a positive byte limit');
  }
  uploadLimits = {
    maxFileBytes,
    maxTotalBytes: Math.min(Number.MAX_SAFE_INTEGER, maxFileBytes * 2),
    maxFiles: MAX_UPLOAD_FILES_PER_REQUEST,
  };
}

export function getUploadLimits(): Readonly<UploadIngressPolicy> {
  return uploadLimits;
}

/**
 * Resolve the only supported daemon-side upload directory.
 */
export function getUploadDirectory(tenantId?: string): string {
  return path.join(getTenantDataRoot(tenantId), 'uploads');
}

export function validateUploadDestinationQuery(destination: unknown): void {
  if (destination == null || destination === '') return;
  if (Array.isArray(destination)) {
    throw Object.assign(new Error('Upload destination options are no longer supported'), {
      status: 400,
    });
  }
  const value = String(destination);
  throw Object.assign(
    new Error(
      `Upload destination '${value}' is no longer supported; uploads use session-scoped staging`
    ),
    { status: 400 }
  );
}

/**
 * Sanitize an original filename (path traversal, unsafe chars) and suffix it
 * with a timestamp so concurrent uploads of the same name never overwrite.
 */
export type StagedMulterFile = Express.Multer.File &
  UploadMetadata & {
    tenantId: TenantID;
    sessionId: SessionID;
    createdBy: import('@disco/core/types').UserID;
    agentId: import('@disco/core/types').AgentID | null;
  };

type UploadRequest = Request & {
  feathers?: { tenant?: { tenant_id?: TenantID } };
  params: { sessionId?: SessionID };
  _stagedUploadBytes?: number;
  _uploadOwner?: import('@disco/core/types').UploadOwner;
};

/**
 * Create multer storage configuration
 */
export function createUploadStorage(
  store: UploadStagingStore,
  limits: Readonly<UploadIngressPolicy> = getUploadLimits()
): multer.StorageEngine {
  return {
    _handleFile(req: UploadRequest, file, callback) {
      const owner = req._uploadOwner;
      if (!owner) {
        callback(new Error('Upload staging requires tenant and session context'));
        return;
      }
      const aggregateLimiter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          req._stagedUploadBytes = (req._stagedUploadBytes ?? 0) + chunk.byteLength;
          if (req._stagedUploadBytes > limits.maxTotalBytes) {
            done(
              Object.assign(
                new Error(`Combined upload size exceeds ceiling ${limits.maxTotalBytes}`),
                { status: 413, code: 'LIMIT_TOTAL_FILE_SIZE' }
              )
            );
            return;
          }
          done(null, chunk);
        },
      });
      file.stream.pipe(aggregateLimiter);
      void store
        .stage({
          owner,
          name: file.originalname,
          mimeType: file.mimetype,
          provenance: 'browser',
          body: aggregateLimiter,
        })
        .then((metadata: UploadMetadata) =>
          callback(null, {
            ...metadata,
            tenantId: owner.tenantId,
            sessionId: owner.sessionId,
            createdBy: owner.createdBy,
            agentId: owner.agentId,
            filename: metadata.name,
            size: metadata.size,
          } as StagedMulterFile)
        )
        .catch(callback);
    },
    _removeFile(_req: UploadRequest, file: Partial<StagedMulterFile>, callback) {
      if (!file.ref || !file.tenantId || !file.sessionId || !file.createdBy) {
        callback(null);
        return;
      }
      void store
        .delete({
          ref: file.ref as UploadRef,
          tenantId: file.tenantId,
          sessionId: file.sessionId,
          createdBy: file.createdBy,
          agentId: file.agentId ?? null,
        })
        .then(() => callback(null))
        .catch(callback);
    },
  };
}

/**
 * Create configured multer instance
 */
export function createUploadMiddleware(store: UploadStagingStore) {
  const limits = getUploadLimits();
  const storage = createUploadStorage(store, limits);

  return multer({
    storage,
    // Browsers encode the quoted multipart filename parameter as UTF-8.
    // Busboy defaults this legacy parameter to Latin-1, which turns names such
    // as `外壳.SLDPRT` into mojibake before storage ever sees them.
    defParamCharset: 'utf8',
    limits: {
      // Per-file ceiling. Multer aborts the upload with `LIMIT_FILE_SIZE`
      // if any single file exceeds this.
      fileSize: limits.maxFileBytes,
      // Hard ceiling on number of files per request.
      files: limits.maxFiles,
      // Aggregate bytes are counted by the streaming storage engine. Browser
      // uploads intentionally have no MIME/extension filter; size and count
      // ceilings remain the ingress safety boundary.
    },
  });
}

/**
 * Pre-multer middleware: reject any request whose declared `Content-Length`
 * exceeds {@link MAX_UPLOAD_TOTAL_SIZE} before we spend time streaming bytes
 * to staging. This cheap check is only an early-out; the streaming storage
 * engine independently counts actual aggregate file bytes.
 *
 * Returns a 413 (Payload Too Large) and short-circuits the chain.
 */
export function enforceTotalUploadSize() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { maxTotalBytes } = getUploadLimits();
    const declared = Number.parseInt(req.headers['content-length'] ?? '', 10);
    if (Number.isFinite(declared) && declared > maxTotalBytes) {
      res.status(413).json({
        error: 'Upload too large',
        details: `Combined upload size ${declared} exceeds ceiling ${maxTotalBytes}`,
        code: 'PAYLOAD_TOO_LARGE',
      });
      return;
    }
    next();
  };
}
