/**
 * Upload middleware using multer for file upload handling
 *
 * Stores daemon-side uploads under ~/.agor/uploads/.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getAgorHome } from '@agor/core/config';
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

// Debug logging only in development
const DEBUG_UPLOAD = process.env.NODE_ENV !== 'production';

const LEGACY_IGNORED_UPLOAD_DESTINATIONS = new Set(['branch', 'global']);

/**
 * Resolve the only supported daemon-side upload directory.
 */
export function getUploadDirectory(): string {
  return path.join(getAgorHome(), 'uploads');
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
      `Upload destination '${value}' is no longer supported; uploads are stored in ~/.agor/uploads/`
    ),
    { status: 400 }
  );
}

/**
 * Sanitize an original filename (path traversal, unsafe chars) and suffix it
 * with a timestamp so concurrent uploads of the same name never overwrite.
 */
export function buildUploadFilename(originalname: string): string {
  const basename = path.basename(originalname);

  const sanitized = basename
    .replace(/\.\./g, '_') // Remove path traversal attempts
    .replace(/[/\\:*?"<>|]/g, '_') // Remove filesystem-unsafe chars (Windows + Unix)
    .replace(/\.+$/g, '') // Remove trailing dots (Windows issue)
    .substring(0, 200); // Limit length (leave room for timestamp)

  const timestamp = Date.now();
  const ext = path.extname(sanitized);
  const nameWithoutExt = sanitized.slice(0, -ext.length || undefined);
  return `${nameWithoutExt}_${timestamp}${ext}`;
}

/**
 * Create multer storage configuration
 */
export function createUploadStorage() {
  const storage = multer.diskStorage({
    destination: async (req: Request, _file, cb) => {
      try {
        const { sessionId } = req.params;
        // NOTE: req.body is NOT available yet during multer's destination callback
        // because multer hasn't parsed the body fields yet. Legacy clients may
        // still send destination as a query param; only the old no-op values are
        // tolerated, and all uploads are written to ~/.agor/uploads/.
        validateUploadDestinationQuery(req.query.destination);

        if (DEBUG_UPLOAD) {
          console.log(
            `📂 [Upload Storage] Processing upload for session ${sessionId || 'unknown'}`
          );
        }

        const dest = getUploadDirectory();

        if (DEBUG_UPLOAD) console.log(`📁 [Upload Storage] Target directory: ${dest}`);

        // Ensure directory exists
        await fs.mkdir(dest, { recursive: true });
        if (DEBUG_UPLOAD) console.log(`✅ [Upload Storage] Directory created/verified: ${dest}`);

        cb(null, dest);
      } catch (error) {
        console.error('❌ [Upload Storage] Error:', error);
        cb(error instanceof Error ? error : new Error(String(error)), '');
      }
    },

    filename: (_req, file, cb) => {
      const uniqueFilename = buildUploadFilename(file.originalname);

      if (DEBUG_UPLOAD) {
        console.log(
          `📝 [Upload Storage] Sanitized filename: ${file.originalname} → ${uniqueFilename}`
        );
      }

      cb(null, uniqueFilename);
    },
  });

  return storage;
}

/**
 * Create configured multer instance
 */
export function createUploadMiddleware() {
  const storage = createUploadStorage();

  return multer({
    storage,
    limits: {
      // Per-file ceiling. Multer aborts the upload with `LIMIT_FILE_SIZE`
      // if any single file exceeds this.
      fileSize: MAX_UPLOAD_FILE_SIZE,
      // Hard ceiling on number of files per request.
      files: MAX_UPLOAD_FILES_PER_REQUEST,
      // NOTE: aggregate file-size enforcement is NOT a multer option —
      // `fieldSize` only governs non-file form-field VALUES, not file payload.
      // The cap on combined file size is enforced separately via
      // `enforceTotalUploadSize()` (pre-multer Content-Length check) and
      // `enforceParsedTotalUploadSize()` (post-multer `req.files` sum), both
      // exported below.
    },
    fileFilter: (_req, file, cb) => {
      // Match on the bare MIME (drop any `; charset=...` parameters).
      const mime = (file.mimetype || '').split(';')[0].trim().toLowerCase();
      if (!ALLOWED_UPLOAD_MIME_TYPES.has(mime)) {
        if (DEBUG_UPLOAD) {
          console.warn(`🚫 [Upload Storage] Rejecting MIME ${mime} for ${file.originalname}`);
        }
        // Pass an Error so the route's error handler returns 4xx with a
        // clear message instead of silently dropping the file.
        const err = new Error(`Unsupported file type: ${mime || 'unknown'}`) as Error & {
          status?: number;
          code?: string;
        };
        err.status = 415;
        err.code = 'UNSUPPORTED_MEDIA_TYPE';
        return cb(err);
      }
      cb(null, true);
    },
  });
}

/**
 * Pre-multer middleware: reject any request whose declared `Content-Length`
 * exceeds {@link MAX_UPLOAD_TOTAL_SIZE} before we spend time streaming bytes
 * to disk. This is a cheap content-length check — clients can lie about it,
 * so it is paired with {@link enforceParsedTotalUploadSize} after multer runs.
 *
 * Returns a 413 (Payload Too Large) and short-circuits the chain.
 */
export function enforceTotalUploadSize() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const declared = Number.parseInt(req.headers['content-length'] ?? '', 10);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_TOTAL_SIZE) {
      res.status(413).json({
        error: 'Upload too large',
        details: `Combined upload size ${declared} exceeds ceiling ${MAX_UPLOAD_TOTAL_SIZE}`,
        code: 'PAYLOAD_TOO_LARGE',
      });
      return;
    }
    next();
  };
}

/**
 * Post-multer middleware: sum the actual sizes of files multer wrote to disk
 * and reject if the aggregate exceeds {@link MAX_UPLOAD_TOTAL_SIZE}. Cleans
 * up the on-disk files before responding so we don't leak bytes when a
 * Content-Length-spoofing client slipped past the pre-check.
 *
 * Returns a 413 (Payload Too Large).
 */
export function enforceParsedTotalUploadSize() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const files = (req as Request & { files?: Express.Multer.File[] }).files;
    if (!Array.isArray(files) || files.length === 0) {
      next();
      return;
    }
    const total = files.reduce((sum, f) => sum + (f.size || 0), 0);
    if (total <= MAX_UPLOAD_TOTAL_SIZE) {
      next();
      return;
    }
    // Best-effort cleanup of the rejected files. We don't await individual
    // failures; an orphaned file is much less bad than a hung response.
    await Promise.allSettled(files.map((f) => fs.unlink(f.path)));
    res.status(413).json({
      error: 'Upload too large',
      details: `Combined file size ${total} exceeds ceiling ${MAX_UPLOAD_TOTAL_SIZE}`,
      code: 'PAYLOAD_TOO_LARGE',
    });
  };
}
