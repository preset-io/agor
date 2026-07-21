import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Task, TaskAttachment } from '@agor/core/types';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSessionImageHandler,
  signComposerImageAttachment,
  stripUntrustedAttachments,
  verifyComposerImageAttachmentTokens,
} from './session-images';

const JWT_SECRET = 'session-image-test-secret';
const SESSION_ID = '018f0000-0000-7000-8000-000000000001';
const TASK_ID = '018f0000-0000-7000-8000-000000000002';
const USER_ID = '018f0000-0000-7000-8000-000000000003';

let server: Server | undefined;
let uploadDirectory: string | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  if (uploadDirectory) {
    await fs.rm(uploadDirectory, { recursive: true, force: true });
    uploadDirectory = undefined;
  }
});

function attachment(filePath: string): TaskAttachment {
  return { filename: 'chart.png', path: filePath, mime_type: 'image/png' };
}

function taskWith(image: TaskAttachment, sessionId = SESSION_ID): Task {
  return {
    task_id: TASK_ID,
    session_id: sessionId,
    created_by: USER_ID,
    metadata: { attachments: [image] },
  } as Task;
}

async function callHandler(options: {
  task: Task | null;
  authorize?: () => Promise<void>;
  imageIndex?: string;
}): Promise<Response> {
  const app = express();
  app.get(
    '/sessions/:sessionId/tasks/:taskId/images/:imageIndex',
    (req, _res, next) => {
      (req as express.Request & { feathers: unknown }).feathers = {
        provider: 'rest',
        user: { user_id: USER_ID },
      };
      next();
    },
    createSessionImageHandler({
      uploadDirectory: uploadDirectory as string,
      getSession: async () => {
        await options.authorize?.();
      },
      getTask: async () => options.task,
    })
  );
  app.use(
    (
      error: Error & { code?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => res.status(error.code ?? 500).json({ error: error.message })
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  return fetch(
    `http://127.0.0.1:${address.port}/sessions/${SESSION_ID}/tasks/${TASK_ID}/images/${options.imageIndex ?? '0'}`
  );
}

describe('composer image attachment tokens', () => {
  it('accepts only image metadata signed by the upload route for the prompting user', () => {
    const image = {
      filename: 'chart.png',
      path: '/tmp/chart.png',
      mime_type: 'image/png',
    } as const;
    const token = signComposerImageAttachment(image, USER_ID, JWT_SECRET);

    expect(verifyComposerImageAttachmentTokens([token], USER_ID, JWT_SECRET)).toEqual([image]);
    expect(() =>
      verifyComposerImageAttachmentTokens([`${token}tampered`], USER_ID, JWT_SECRET)
    ).toThrow('Invalid image attachment');
    expect(() => verifyComposerImageAttachmentTokens([token], 'another-user', JWT_SECRET)).toThrow(
      'Invalid image attachment'
    );
  });

  it('strips caller-authored attachments before prompt task metadata is persisted', () => {
    const image = attachment('/tmp/untrusted.png');

    expect(stripUntrustedAttachments({ system_authored: true, attachments: [image] })).toEqual({
      system_authored: true,
    });
  });
});

describe('GET session image handler', () => {
  it('serves associated image bytes after session view authorization', async () => {
    uploadDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-session-images-'));
    const imagePath = path.join(uploadDirectory, 'chart.png');
    await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const authorize = vi.fn(async () => undefined);

    const response = await callHandler({ task: taskWith(attachment(imagePath)), authorize });

    expect(authorize).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    );
  });

  it('propagates session view authorization failures before reading task metadata', async () => {
    uploadDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-session-images-'));
    const denied = Object.assign(new Error('Not authorized to view this session'), { code: 403 });

    const response = await callHandler({
      task: null,
      authorize: async () => {
        throw denied;
      },
    });

    expect(response.status).toBe(403);
  });

  it('rejects images associated with a different session', async () => {
    uploadDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-session-images-'));
    const imagePath = path.join(uploadDirectory, 'chart.png');
    await fs.writeFile(imagePath, 'private image');

    const response = await callHandler({
      task: taskWith(attachment(imagePath), '018f0000-0000-7000-8000-000000000099'),
    });

    expect(response.status).toBe(404);
  });

  it('rejects traversal and symlink escapes from the upload directory', async () => {
    uploadDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-session-images-'));
    const outsideDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'agor-session-images-outside-')
    );
    const outsidePath = path.join(outsideDirectory, 'secret.png');
    await fs.writeFile(outsidePath, 'secret');
    const symlinkPath = path.join(uploadDirectory, 'escape.png');
    await fs.symlink(outsidePath, symlinkPath);

    const traversalResponse = await callHandler({ task: taskWith(attachment(outsidePath)) });
    expect(traversalResponse.status).toBe(404);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;

    const symlinkResponse = await callHandler({ task: taskWith(attachment(symlinkPath)) });
    expect(symlinkResponse.status).toBe(404);
    await fs.rm(outsideDirectory, { recursive: true, force: true });
  });

  it('returns 404 for missing or invalid attachment indexes', async () => {
    uploadDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-session-images-'));
    const imagePath = path.join(uploadDirectory, 'missing.png');

    const missingResponse = await callHandler({ task: taskWith(attachment(imagePath)) });
    expect(missingResponse.status).toBe(404);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;

    const invalidResponse = await callHandler({
      task: taskWith(attachment(imagePath)),
      imageIndex: '../0',
    });
    expect(invalidResponse.status).toBe(404);
  });
});
