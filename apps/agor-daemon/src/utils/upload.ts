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
      fileSize: 50 * 1024 * 1024, // 50MB max file size
      files: 10, // Max 10 files per request
    },
    // No file filter - accept all types (multimodal-ready)
  });
}
