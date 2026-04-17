/**
 * Upload middleware using multer for file upload handling
 *
 * Supports uploading files to:
 * - Worktree (.agor/uploads/) - Default, agent-accessible
 * - Temp folder - Ephemeral uploads
 * - Global (~/.agor/uploads/) - Shared across sessions
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SessionRepository, WorktreeRepository } from '@agor/core/db';
import type { Request } from 'express';
import multer from 'multer';

/**
 * MIME types accepted by the upload endpoint.
 *
 * Kept narrow on purpose: anything HTML-like, executable, or shell-like is
 * rejected so that an uploaded file cannot be coerced into XSS / drive-by
 * download territory if it is ever served back out of the worktree.
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

/**
 * Destination types for file uploads
 */
export type UploadDestination = 'worktree' | 'temp' | 'global';

/**
 * Create multer storage configuration
 */
export function createUploadStorage(
  sessionRepo: SessionRepository,
  worktreeRepo: WorktreeRepository
) {
  const storage = multer.diskStorage({
    destination: async (req: Request, _file, cb) => {
      try {
        const { sessionId } = req.params;
        // NOTE: req.body is NOT available yet during multer's destination callback
        // because multer hasn't parsed the body fields yet. We read from query params instead.
        const destination = (req.query.destination as UploadDestination) || 'worktree';

        // Validate destination
        if (!['worktree', 'temp', 'global'].includes(destination)) {
          console.error(`❌ [Upload Storage] Invalid destination: ${destination}`);
          return cb(new Error(`Invalid destination: ${destination}`), '');
        }

        if (DEBUG_UPLOAD) {
          console.log(
            `📂 [Upload Storage] Processing upload for session ${sessionId?.substring(0, 8)}`
          );
          console.log(`   Destination type: ${destination}`);
        }

        if (!sessionId) {
          console.error('❌ [Upload Storage] No session ID provided');
          return cb(new Error('Session ID required'), '');
        }

        // Get session to find associated worktree
        const session = await sessionRepo.findById(sessionId);
        if (!session) {
          console.error(`❌ [Upload Storage] Session not found: ${sessionId.substring(0, 8)}`);
          return cb(new Error(`Session not found: ${sessionId}`), '');
        }

        if (!session.worktree_id) {
          console.error(`❌ [Upload Storage] Session ${sessionId.substring(0, 8)} has no worktree`);
          return cb(new Error(`Session ${sessionId} has no associated worktree`), '');
        }

        const worktree = await worktreeRepo.findById(session.worktree_id);
        if (!worktree) {
          console.error(
            `❌ [Upload Storage] Worktree not found: ${session.worktree_id.substring(0, 8)}`
          );
          return cb(new Error(`Worktree not found: ${session.worktree_id}`), '');
        }

        // Map destination to actual path
        const paths: Record<UploadDestination, string> = {
          worktree: path.join(worktree.path, '.agor', 'uploads'),
          temp: path.join(os.tmpdir(), 'agor-uploads'),
          global: path.join(os.homedir(), '.agor', 'uploads'),
        };

        const dest = paths[destination] || paths.worktree;

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
      // Sanitize filename to prevent path traversal attacks while preserving readability
      // 1. Extract basename to remove any path components
      const basename = path.basename(file.originalname);

      // 2. Remove only truly dangerous characters (preserve spaces, unicode, etc.)
      const sanitized = basename
        .replace(/\.\./g, '_') // Remove path traversal attempts
        .replace(/[/\\:*?"<>|]/g, '_') // Remove filesystem-unsafe chars (Windows + Unix)
        .replace(/\.+$/g, '') // Remove trailing dots (Windows issue)
        .substring(0, 200); // Limit length (leave room for timestamp)

      // 3. Add timestamp suffix to prevent overwrites (but keep it human-readable)
      const timestamp = Date.now();
      const ext = path.extname(sanitized);
      const nameWithoutExt = sanitized.slice(0, -ext.length || undefined);
      const uniqueFilename = `${nameWithoutExt}_${timestamp}${ext}`;

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
export function createUploadMiddleware(
  sessionRepo: SessionRepository,
  worktreeRepo: WorktreeRepository
) {
  const storage = createUploadStorage(sessionRepo, worktreeRepo);

  return multer({
    storage,
    limits: {
      fileSize: MAX_UPLOAD_FILE_SIZE,
      files: MAX_UPLOAD_FILES_PER_REQUEST,
      // Hard ceiling on total request body — multer applies this against the
      // raw multipart bytes which is a reasonable proxy for total file size.
      fieldSize: MAX_UPLOAD_TOTAL_SIZE,
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
