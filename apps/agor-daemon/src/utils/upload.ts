/**
 * Upload middleware using multer for file upload handling
 *
 * Streams multipart ingress into the configured tenant/session staging store.
 */

import path from 'node:path';
import { Transform } from 'node:stream';
import { getTenantDataRoot } from '@agor/core/config';
import type {
  SessionID,
  TenantID,
  UploadIngressPolicy,
  UploadMetadata,
  UploadRef,
  UploadStagingStore,
} from '@agor/core/types';
import { UPLOAD_POLICY_ERROR_CONTRACT } from '@agor/core/types';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';

/**
 * MIME types accepted by the upload endpoint.
 *
 * Kept narrow on purpose: anything HTML-like, executable, or shell-like is
 * rejected so that an uploaded file cannot be coerced into XSS / drive-by
 * download territory if it is ever served back out of the branch.
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
export const MAX_UPLOAD_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
/** Max number of files in a single multipart request. */
export const MAX_UPLOAD_FILES_PER_REQUEST = 10;
/** Max combined size of all files in a single request (bytes). */
export const MAX_UPLOAD_TOTAL_SIZE = 100 * 1024 * 1024; // 100 MB

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
    maxTotalBytes: maxFileBytes * 2,
    maxFiles: MAX_UPLOAD_FILES_PER_REQUEST,
  };
}

export function getUploadLimits(): Readonly<UploadIngressPolicy> {
  return uploadLimits;
}

const LEGACY_IGNORED_UPLOAD_DESTINATIONS = new Set(['branch', 'global']);

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
  // Old clients sent the previous default (`branch`) or explicit `global`.
  // Treat those as no-ops so they write to the single supported location.
  if (LEGACY_IGNORED_UPLOAD_DESTINATIONS.has(value)) return;
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
    branchId: import('@agor/core/types').BranchID;
  };

type UploadRequest = Request & {
  feathers?: { tenant?: { tenant_id?: TenantID } };
  params: { sessionId?: SessionID };
  _stagedUploadBytes?: number;
  _uploadOwner?: import('@agor/core/types').UploadOwner;
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
                {
                  status: UPLOAD_POLICY_ERROR_CONTRACT.totalFileSize.status,
                  code: UPLOAD_POLICY_ERROR_CONTRACT.totalFileSize.code,
                }
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
            branchId: owner.branchId,
            filename: metadata.name,
            size: metadata.size,
          } as StagedMulterFile)
        )
        .catch(callback);
    },
    _removeFile(_req: UploadRequest, file: Partial<StagedMulterFile>, callback) {
      if (!file.ref || !file.tenantId || !file.sessionId || !file.branchId) {
        callback(null);
        return;
      }
      void store
        .delete({
          ref: file.ref as UploadRef,
          tenantId: file.tenantId,
          sessionId: file.sessionId,
          branchId: file.branchId,
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
    limits: {
      // Per-file ceiling. Multer aborts the upload with `LIMIT_FILE_SIZE`
      // if any single file exceeds this.
      fileSize: limits.maxFileBytes,
      // Hard ceiling on number of files per request.
      files: limits.maxFiles,
      // Aggregate bytes are counted by the streaming storage engine.
    },
    fileFilter: (_req, file, cb) => {
      // Match on the bare MIME (drop any `; charset=...` parameters).
      const mime = (file.mimetype || '').split(';')[0].trim().toLowerCase();
      if (!ALLOWED_UPLOAD_MIME_TYPES.has(mime)) {
        // Pass an Error so the route's error handler returns 4xx with a
        // clear message instead of silently dropping the file.
        const err = new Error(`Unsupported file type: ${mime || 'unknown'}`) as Error & {
          status?: number;
          code?: string;
        };
        err.status = UPLOAD_POLICY_ERROR_CONTRACT.unsupportedMediaType.status;
        err.code = UPLOAD_POLICY_ERROR_CONTRACT.unsupportedMediaType.code;
        return cb(err);
      }
      cb(null, true);
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
      const requestId = (req as Request & { _uploadRequestId?: string })._uploadRequestId;
      res.locals ??= {};
      res.locals.uploadFailureCode = UPLOAD_POLICY_ERROR_CONTRACT.payloadTooLarge.code;
      res.locals.uploadFailureType = 'upload_policy';
      res.status(UPLOAD_POLICY_ERROR_CONTRACT.payloadTooLarge.status).json({
        error: 'Upload too large',
        details: `Combined upload size ${declared} exceeds ceiling ${maxTotalBytes}`,
        code: UPLOAD_POLICY_ERROR_CONTRACT.payloadTooLarge.code,
        ...(requestId && { requestId }),
      });
      return;
    }
    next();
  };
}
