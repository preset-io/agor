import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AuthenticatedParams, Task, TaskAttachment, TaskMetadata } from '@agor/core/types';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { isPathInsideRoot } from './branch-workspace-path.js';
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  hasNoAsciiControlCharacters,
  PREVIEW_IMAGE_MIME_TYPES,
  sanitizeUploadDisplayFilename,
} from './upload.js';

const COMPOSER_ATTACHMENT_TOKEN_TYPE = 'composer-attachment';

function isValidStorageKey(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value !== '.' &&
    value !== '..' &&
    !path.isAbsolute(value) &&
    !value.includes('\\') &&
    hasNoAsciiControlCharacters(value) &&
    path.basename(value) === value
  );
}

function isValidTaskAttachment(value: unknown): value is TaskAttachment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const attachment = value as Partial<TaskAttachment>;
  return (
    typeof attachment.storage_key === 'string' &&
    isValidStorageKey(attachment.storage_key) &&
    typeof attachment.filename === 'string' &&
    attachment.filename.length > 0 &&
    attachment.filename === sanitizeUploadDisplayFilename(attachment.filename, '') &&
    typeof attachment.mime_type === 'string' &&
    ALLOWED_UPLOAD_MIME_TYPES.has(attachment.mime_type)
  );
}

export function signComposerAttachment(
  attachment: TaskAttachment,
  userId: string,
  sessionId: string,
  tenantId: string | undefined,
  jwtSecret: string
): string {
  if (!isValidTaskAttachment(attachment)) {
    throw new Error('Invalid task attachment');
  }
  return jwt.sign(
    {
      type: COMPOSER_ATTACHMENT_TOKEN_TYPE,
      storage_key: attachment.storage_key,
      filename: attachment.filename,
      mime_type: attachment.mime_type,
      session_id: sessionId,
      tenant_id: tenantId ?? null,
    },
    jwtSecret,
    { issuer: 'agor', subject: userId, expiresIn: '1h' }
  );
}

export function verifyComposerAttachmentTokens(
  tokens: string[],
  userId: string,
  sessionId: string,
  tenantId: string | undefined,
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
        payload.type !== COMPOSER_ATTACHMENT_TOKEN_TYPE ||
        payload.session_id !== sessionId ||
        payload.tenant_id !== (tenantId ?? null) ||
        !isValidTaskAttachment(payload)
      ) {
        throw new Error('invalid payload');
      }
      return {
        storage_key: payload.storage_key,
        filename: payload.filename,
        mime_type: payload.mime_type,
      };
    });
  } catch {
    throw new Error('Invalid task attachment');
  }
}

export function stripUntrustedAttachments(
  metadata: Partial<TaskMetadata> | undefined
): Partial<TaskMetadata> {
  const { attachments: _attachments, ...trustedMetadata } = metadata ?? {};
  return trustedMetadata;
}

/**
 * Validate daemon-authored attachment metadata before it crosses the prompt
 * route's internal-call seam (gateway ingestion).
 */
export function validateTrustedTaskAttachments(value: unknown): TaskAttachment[] {
  if (!Array.isArray(value) || value.length > 10 || !value.every(isValidTaskAttachment)) {
    throw new Error('Invalid trusted task attachments');
  }
  return value;
}

interface TaskAttachmentHandlerOptions {
  uploadDirectory: string;
  getSession: (sessionId: string, params: AuthenticatedParams) => Promise<unknown>;
  getTask: (taskId: string, params: AuthenticatedParams) => Promise<Task | null>;
  purpose: 'preview' | 'materialize';
}

function notFound(res: Response, purpose: TaskAttachmentHandlerOptions['purpose']): void {
  res
    .status(404)
    .json({ error: purpose === 'preview' ? 'Image not found' : 'Attachment not found' });
}

function hasMatchingExecutorScope(
  params: AuthenticatedParams,
  sessionId: string,
  taskId: string
): boolean {
  const scoped = params as AuthenticatedParams & {
    session_id?: string;
    task_id?: string;
    authentication?: {
      strategy?: string;
      payload?: { type?: string; purpose?: string; session_id?: string; task_id?: string };
    };
  };
  const payload = scoped.authentication?.payload;
  const scopedSessionId = scoped.session_id ?? payload?.session_id;
  const scopedTaskId = scoped.task_id ?? payload?.task_id;
  return (
    scoped.authentication?.strategy === 'jwt' &&
    payload?.type === 'executor-session' &&
    payload.purpose === 'executor-task' &&
    scopedSessionId === sessionId &&
    scopedTaskId === taskId
  );
}

export function createTaskAttachmentHandler({
  uploadDirectory,
  getSession,
  getTask,
  purpose,
}: TaskAttachmentHandlerOptions): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const params = (req as Request & { feathers?: AuthenticatedParams }).feathers;
      if (!params) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const { sessionId, taskId } = req.params;
      const rawAttachmentIndex = req.params.attachmentIndex ?? req.params.imageIndex;
      if (purpose === 'materialize' && !hasMatchingExecutorScope(params, sessionId, taskId)) {
        notFound(res, purpose);
        return;
      }
      await getSession(sessionId, params);

      if (!/^\d+$/.test(rawAttachmentIndex)) {
        notFound(res, purpose);
        return;
      }
      const task = await getTask(taskId, params);
      const attachmentIndex = Number(rawAttachmentIndex);
      const attachment = task?.metadata?.attachments?.[attachmentIndex];
      const allowedMimeTypes =
        purpose === 'preview' ? PREVIEW_IMAGE_MIME_TYPES : ALLOWED_UPLOAD_MIME_TYPES;
      if (
        !task ||
        task.session_id !== sessionId ||
        !attachment ||
        !isValidTaskAttachment(attachment) ||
        !allowedMimeTypes.has(attachment.mime_type)
      ) {
        notFound(res, purpose);
        return;
      }

      let uploadRoot: string;
      let attachmentPath: string;
      try {
        uploadRoot = await fs.realpath(uploadDirectory);
        attachmentPath = await fs.realpath(path.join(uploadRoot, attachment.storage_key));
      } catch {
        notFound(res, purpose);
        return;
      }
      if (!isPathInsideRoot(uploadRoot, attachmentPath)) {
        notFound(res, purpose);
        return;
      }

      const fileHandle = await fs
        .open(attachmentPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
        .catch(() => null);
      if (!fileHandle) {
        notFound(res, purpose);
        return;
      }
      const stats = await fileHandle.stat();
      if (!stats.isFile()) {
        await fileHandle.close();
        notFound(res, purpose);
        return;
      }

      res.setHeader('Content-Type', attachment.mime_type);
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (purpose === 'materialize') {
        res.setHeader(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(attachment.filename))}`
        );
      }
      fileHandle.createReadStream().on('error', next).pipe(res);
    } catch (error) {
      next(error);
    }
  };
}
