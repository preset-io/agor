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

        console.log(
          `📂 [Upload Storage] Processing upload for session ${sessionId?.substring(0, 8)}`
        );
        console.log(`   Destination type: ${destination}`);

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

        console.log(`📁 [Upload Storage] Target directory: ${dest}`);

        // Ensure directory exists
        await fs.mkdir(dest, { recursive: true });
        console.log(`✅ [Upload Storage] Directory created/verified: ${dest}`);

        cb(null, dest);
      } catch (error) {
        console.error('❌ [Upload Storage] Error:', error);
        cb(error instanceof Error ? error : new Error(String(error)), '');
      }
    },

    filename: (_req, file, cb) => {
      // Sanitize filename to prevent path traversal attacks
      // 1. Extract basename to remove any path components
      const basename = path.basename(file.originalname);

      // 2. Remove dangerous characters and normalize
      const sanitized = basename
        .replace(/[^a-zA-Z0-9._-]/g, '_') // Replace dangerous chars with underscore
        .replace(/\.+/g, '.') // Collapse multiple dots
        .replace(/^\.+/, '') // Remove leading dots
        .substring(0, 255); // Limit length

      // 3. Add timestamp to prevent overwrites
      const timestamp = Date.now();
      const ext = path.extname(sanitized);
      const nameWithoutExt = sanitized.slice(0, -ext.length || undefined);
      const uniqueFilename = `${nameWithoutExt}_${timestamp}${ext}`;

      console.log(
        `📝 [Upload Storage] Sanitized filename: ${file.originalname} → ${uniqueFilename}`
      );

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
