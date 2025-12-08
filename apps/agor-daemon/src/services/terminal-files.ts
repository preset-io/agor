/**
 * Terminal Files Service
 *
 * Handles screenshot uploads for terminal sessions.
 * Saves uploaded images to .agor/tmp/screenshots/ within the worktree.
 * Returns relative paths for terminal use.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Database } from '@agor/core/db';
import { WorktreeRepository } from '@agor/core/db';
import { generateId } from '@agor/core';
import type { Application } from '@agor/core/feathers';
import type { AuthenticatedParams, WorktreeID } from '@agor/core/types';
import type { Request, Response } from 'express';
import multer from 'multer';

const DEBUG = process.env.NODE_ENV !== 'production';

// Max file size: 10MB
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Allowed image MIME types
const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];

interface UploadedFile {
  path: string;
  absolutePath: string;
  filename: string;
  size: number;
  mimeType: string;
}

/**
 * Terminal Files Service
 */
export class TerminalFilesService {
  private app: Application;
  private worktreeRepo: WorktreeRepository;

  constructor(app: Application, db: Database) {
    this.app = app;
    this.worktreeRepo = new WorktreeRepository(db);
  }

  /**
   * Create multer upload middleware for this service
   */
  createUploadMiddleware() {
    const storage = multer.diskStorage({
      destination: async (req: Request, _file, cb) => {
        try {
          const worktreeId = req.body.worktreeId as WorktreeID;

          if (!worktreeId) {
            if (DEBUG) console.error('❌ [Terminal Files] No worktreeId provided');
            return cb(new Error('worktreeId required'), '');
          }

          // Get worktree to find path
          const worktree = await this.worktreeRepo.findById(worktreeId);
          if (!worktree) {
            if (DEBUG)
              console.error(`❌ [Terminal Files] Worktree not found: ${worktreeId.substring(0, 8)}`);
            return cb(new Error(`Worktree not found: ${worktreeId}`), '');
          }

          // Create screenshots directory in worktree
          const screenshotsDir = path.join(worktree.path, '.agor', 'tmp', 'screenshots');

          if (DEBUG) console.log(`📂 [Terminal Files] Target directory: ${screenshotsDir}`);

          // Ensure directory exists
          await fs.mkdir(screenshotsDir, { recursive: true });

          cb(null, screenshotsDir);
        } catch (error) {
          console.error('❌ [Terminal Files] Error:', error);
          cb(error instanceof Error ? error : new Error(String(error)), '');
        }
      },

      filename: (_req, file, cb) => {
        // Generate UUID-based filename
        const ext = path.extname(file.originalname);
        const filename = `screenshot-${generateId().replace(/-/g, '')}${ext}`;

        if (DEBUG) {
          console.log(`📝 [Terminal Files] Filename: ${file.originalname} → ${filename}`);
        }

        cb(null, filename);
      },
    });

    return multer({
      storage,
      limits: {
        fileSize: MAX_FILE_SIZE,
        files: 1, // Only one file per upload
      },
      fileFilter: (_req, file, cb) => {
        // Validate MIME type
        if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
          if (DEBUG)
            console.error(`❌ [Terminal Files] Invalid MIME type: ${file.mimetype}`);
          return cb(
            new Error(
              `Invalid file type. Only images are supported (PNG, JPEG, WEBP). Got: ${file.mimetype}`
            )
          );
        }
        cb(null, true);
      },
    });
  }

  /**
   * Handle file upload
   * This is called AFTER multer has processed the upload
   */
  async create(data: unknown, params: AuthenticatedParams): Promise<UploadedFile> {
    // multer attaches file to req, so we need to access it from params
    const req = params.req as Request & { file?: Express.Multer.File };

    if (!req?.file) {
      throw new Error('No file uploaded');
    }

    const file = req.file;
    const worktreeId = req.body.worktreeId as WorktreeID;

    if (!worktreeId) {
      // Clean up uploaded file
      await fs.unlink(file.path).catch(() => {});
      throw new Error('worktreeId required');
    }

    // Get worktree to calculate relative path
    const worktree = await this.worktreeRepo.findById(worktreeId);
    if (!worktree) {
      // Clean up uploaded file
      await fs.unlink(file.path).catch(() => {});
      throw new Error(`Worktree not found: ${worktreeId}`);
    }

    // Calculate relative path from worktree root
    const relativePath = path.relative(worktree.path, file.path);

    if (DEBUG) {
      console.log(`✅ [Terminal Files] File uploaded successfully`);
      console.log(`   Absolute: ${file.path}`);
      console.log(`   Relative: ${relativePath}`);
      console.log(`   Size: ${file.size} bytes`);
      console.log(`   MIME: ${file.mimetype}`);
    }

    return {
      path: `./${relativePath}`, // Relative path for terminal use
      absolutePath: file.path,
      filename: file.filename,
      size: file.size,
      mimeType: file.mimetype,
    };
  }

  /**
   * Delete a screenshot by absolute path
   */
  async remove(id: string, params: AuthenticatedParams): Promise<{ id: string }> {
    try {
      await fs.unlink(id);
      if (DEBUG) console.log(`🗑️  [Terminal Files] Deleted: ${id}`);
      return { id };
    } catch (error) {
      console.error(`❌ [Terminal Files] Failed to delete: ${id}`, error);
      throw new Error(`Failed to delete file: ${id}`);
    }
  }
}
