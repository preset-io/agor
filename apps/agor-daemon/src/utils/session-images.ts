import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import type { AuthenticatedParams, Task, TaskAttachment, TaskMetadata } from '@agor/core/types';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { isPathInsideRoot } from './branch-workspace-path.js';
import { PREVIEW_IMAGE_MIME_TYPES } from './upload.js';

const COMPOSER_IMAGE_TOKEN_TYPE = 'composer-image';

export function signComposerImageAttachment(
  attachment: TaskAttachment,
  userId: string,
  jwtSecret: string
): string {
  return jwt.sign(
    {
      type: COMPOSER_IMAGE_TOKEN_TYPE,
      filename: attachment.filename,
      path: attachment.path,
      mime_type: attachment.mime_type,
    },
    jwtSecret,
    { issuer: 'agor', subject: userId, expiresIn: '1h' }
  );
}

export function verifyComposerImageAttachmentTokens(
  tokens: string[],
  userId: string,
  jwtSecret: string
): TaskAttachment[] {
  try {
    return tokens.map((token) => {
      const payload = jwt.verify(token, jwtSecret, {
        issuer: 'agor',
        subject: userId,
      });
      if (
        typeof payload === 'string' ||
        payload.type !== COMPOSER_IMAGE_TOKEN_TYPE ||
        typeof payload.filename !== 'string' ||
        typeof payload.path !== 'string' ||
        typeof payload.mime_type !== 'string' ||
        !PREVIEW_IMAGE_MIME_TYPES.has(payload.mime_type)
      ) {
        throw new Error('invalid payload');
      }
      return {
        filename: payload.filename,
        path: payload.path,
        mime_type: payload.mime_type as TaskAttachment['mime_type'],
      };
    });
  } catch {
    throw new Error('Invalid image attachment');
  }
}

export function stripUntrustedAttachments(
  metadata: Partial<TaskMetadata> | undefined
): Partial<TaskMetadata> {
  const { attachments: _attachments, ...trustedMetadata } = metadata ?? {};
  return trustedMetadata;
}

interface SessionImageHandlerOptions {
  uploadDirectory: string;
  getSession: (sessionId: string, params: AuthenticatedParams) => Promise<unknown>;
  getTask: (taskId: string, params: AuthenticatedParams) => Promise<Task | null>;
}

function notFound(res: Response): void {
  res.status(404).json({ error: 'Image not found' });
}

export function createSessionImageHandler({
  uploadDirectory,
  getSession,
  getTask,
}: SessionImageHandlerOptions): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const params = (req as Request & { feathers?: AuthenticatedParams }).feathers;
      if (!params) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const { sessionId, taskId, imageIndex: rawImageIndex } = req.params;
      await getSession(sessionId, params);

      if (!/^\d+$/.test(rawImageIndex)) {
        notFound(res);
        return;
      }
      const task = await getTask(taskId, params);
      const imageIndex = Number(rawImageIndex);
      const attachment = task?.metadata?.attachments?.[imageIndex];
      if (
        !task ||
        task.session_id !== sessionId ||
        !attachment ||
        !PREVIEW_IMAGE_MIME_TYPES.has(attachment.mime_type)
      ) {
        notFound(res);
        return;
      }

      let uploadRoot: string;
      let imagePath: string;
      try {
        [uploadRoot, imagePath] = await Promise.all([
          fs.realpath(uploadDirectory),
          fs.realpath(attachment.path),
        ]);
      } catch {
        notFound(res);
        return;
      }
      if (!isPathInsideRoot(uploadRoot, imagePath)) {
        notFound(res);
        return;
      }

      const stats = await fs.stat(imagePath).catch(() => null);
      if (!stats?.isFile()) {
        notFound(res);
        return;
      }

      res.setHeader('Content-Type', attachment.mime_type);
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      createReadStream(imagePath).on('error', next).pipe(res);
    } catch (error) {
      next(error);
    }
  };
}
