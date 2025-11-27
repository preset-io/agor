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
        const destination = (req.body.destination as UploadDestination) || 'worktree';

        if (!sessionId) {
          return cb(new Error('Session ID required'), '');
        }

        // Get session to find associated worktree
        const session = await sessionRepo.findById(sessionId);
        if (!session) {
          return cb(new Error(`Session not found: ${sessionId}`), '');
        }

        if (!session.worktree_id) {
          return cb(new Error(`Session ${sessionId} has no associated worktree`), '');
        }

        const worktree = await worktreeRepo.findById(session.worktree_id);
        if (!worktree) {
          return cb(new Error(`Worktree not found: ${session.worktree_id}`), '');
        }

        // Map destination to actual path
        const paths: Record<UploadDestination, string> = {
          worktree: path.join(worktree.path, '.agor', 'uploads'),
          temp: path.join(os.tmpdir(), 'agor-uploads'),
          global: path.join(os.homedir(), '.agor', 'uploads'),
        };

        const dest = paths[destination] || paths.worktree;

        // Ensure directory exists
        await fs.mkdir(dest, { recursive: true });

        cb(null, dest);
      } catch (error) {
        cb(error instanceof Error ? error : new Error(String(error)), '');
      }
    },

    filename: (_req, file, cb) => {
      // Preserve original filename (will overwrite duplicates)
      cb(null, file.originalname);
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
