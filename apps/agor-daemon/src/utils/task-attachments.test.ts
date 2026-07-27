import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Task, TaskAttachment } from '@agor/core/types';
import express from 'express';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTaskAttachmentHandler,
  ensureToolSupportsTaskAttachments,
  signComposerAttachment,
  stripUntrustedAttachments,
  validateTrustedTaskAttachments,
  verifyComposerAttachmentTokens,
} from './task-attachments';

const JWT_SECRET = 'task-attachment-test-secret';
const SESSION_ID = '018f0000-0000-7000-8000-000000000001';
const TASK_ID = '018f0000-0000-7000-8000-000000000002';
const USER_ID = '018f0000-0000-7000-8000-000000000003';
const TENANT_ID = '018f0000-0000-7000-8000-000000000004';

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

function attachment(storageKey: string, overrides: Partial<TaskAttachment> = {}): TaskAttachment {
  return {
    storage_key: storageKey,
    filename: 'chart.png',
    mime_type: 'image/png',
    ...overrides,
  };
}

function taskWith(file: TaskAttachment, sessionId = SESSION_ID): Task {
  return {
    task_id: TASK_ID,
    session_id: sessionId,
    created_by: USER_ID,
    full_prompt: 'Compare this chart',
    metadata: { attachments: [file] },
  } as Task;
}

async function callHandler(options: {
  task: Task | null;
  authorize?: () => Promise<void>;
  imageIndex?: string;
  purpose?: 'preview' | 'materialize';
  scopedSessionId?: string;
  scopedTaskId?: string;
}): Promise<Response> {
  const purpose = options.purpose ?? 'preview';
  const app = express();
  app.get(
    `/sessions/:sessionId/tasks/:taskId/${purpose === 'preview' ? 'images' : 'attachments'}/:imageIndex`,
    (req, _res, next) => {
      (req as express.Request & { feathers: unknown }).feathers = {
        provider: 'rest',
        user: { user_id: USER_ID },
        authentication: {
          strategy: 'jwt',
          payload: {
            type: purpose === 'materialize' ? 'executor-session' : 'access',
            purpose: purpose === 'materialize' ? 'executor-task' : undefined,
            session_id: options.scopedSessionId,
            task_id: options.scopedTaskId,
          },
        },
        session_id: options.scopedSessionId,
        task_id: options.scopedTaskId,
      };
      next();
    },
    createTaskAttachmentHandler({
      uploadDirectory: uploadDirectory as string,
      getSession: async () => {
        await options.authorize?.();
      },
      getTask: async () => options.task,
      purpose,
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
    `http://127.0.0.1:${address.port}/sessions/${SESSION_ID}/tasks/${TASK_ID}/${
      purpose === 'preview' ? 'images' : 'attachments'
    }/${options.imageIndex ?? '0'}`
  );
}

describe('composer attachment tokens', () => {
  it('contains only opaque metadata signed for the prompting user', () => {
    const file = attachment('chart_123.png');
    const token = signComposerAttachment(file, USER_ID, SESSION_ID, TENANT_ID, JWT_SECRET);
    const decoded = jwt.decode(token) as jwt.JwtPayload;

    expect(decoded).toMatchObject(file);
    expect(decoded).not.toHaveProperty('path');
    expect(
      verifyComposerAttachmentTokens([token], USER_ID, SESSION_ID, TENANT_ID, JWT_SECRET)
    ).toEqual([file]);
    expect(() =>
      verifyComposerAttachmentTokens(
        [`${token}tampered`],
        USER_ID,
        SESSION_ID,
        TENANT_ID,
        JWT_SECRET
      )
    ).toThrow('Invalid task attachment');
    expect(() =>
      verifyComposerAttachmentTokens([token], 'another-user', SESSION_ID, TENANT_ID, JWT_SECRET)
    ).toThrow('Invalid task attachment');
    expect(() =>
      verifyComposerAttachmentTokens(
        [token],
        USER_ID,
        '018f0000-0000-7000-8000-000000000099',
        TENANT_ID,
        JWT_SECRET
      )
    ).toThrow('Invalid task attachment');
    expect(() =>
      verifyComposerAttachmentTokens(
        [token],
        USER_ID,
        SESSION_ID,
        '018f0000-0000-7000-8000-000000000099',
        JWT_SECRET
      )
    ).toThrow('Invalid task attachment');
  });

  it('accepts validated internal metadata and strips caller-authored associations', () => {
    const file = attachment('notes_123.txt', {
      filename: 'notes.txt',
      mime_type: 'text/plain',
    });

    expect(validateTrustedTaskAttachments([file])).toEqual([file]);
    expect(() =>
      validateTrustedTaskAttachments([{ ...file, storage_key: '../notes.txt' }])
    ).toThrow('Invalid trusted task attachments');
    expect(() =>
      validateTrustedTaskAttachments([{ ...file, filename: 'notes\r\nx-header.txt' }])
    ).toThrow('Invalid trusted task attachments');
    expect(
      validateTrustedTaskAttachments([{ ...file, path: '/daemon/uploads/notes.txt' }])
    ).toEqual([file]);
    expect(stripUntrustedAttachments({ system_authored: true, attachments: [file] })).toEqual({
      system_authored: true,
    });
  });

  it('rejects Claude Code CLI attachments instead of silently dropping them', () => {
    const file = attachment('notes-key', {
      filename: 'notes.txt',
      mime_type: 'text/plain',
    });

    expect(() => ensureToolSupportsTaskAttachments('claude-code-cli', [file])).toThrow(
      'Attachments are not supported by claude-code-cli sessions'
    );
    expect(() => ensureToolSupportsTaskAttachments('claude-code', [file])).not.toThrow();
    expect(() => ensureToolSupportsTaskAttachments('claude-code-cli', [])).not.toThrow();
  });
});

describe('task attachment retrieval', () => {
  it('serves associated image bytes after session view authorization', async () => {
    uploadDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-task-attachments-'));
    await fs.writeFile(path.join(uploadDirectory, 'chart.png'), Buffer.from([0x89, 0x50, 0x4e]));
    const authorize = vi.fn(async () => undefined);

    const response = await callHandler({ task: taskWith(attachment('chart.png')), authorize });

    expect(authorize).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([0x89, 0x50, 0x4e]));
  });

  it('requires the exact executor session and task scope for materialization', async () => {
    uploadDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-task-attachments-'));
    await fs.writeFile(path.join(uploadDirectory, 'notes.txt'), 'private notes');
    const task = taskWith(
      attachment('notes.txt', { filename: 'notes.txt', mime_type: 'text/plain' })
    );

    const unscoped = await callHandler({ task, purpose: 'materialize' });
    expect(unscoped.status).toBe(404);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;

    const wrongTask = await callHandler({
      task,
      purpose: 'materialize',
      scopedSessionId: SESSION_ID,
      scopedTaskId: '018f0000-0000-7000-8000-000000000099',
    });
    expect(wrongTask.status).toBe(404);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;

    const scoped = await callHandler({
      task,
      purpose: 'materialize',
      scopedSessionId: SESSION_ID,
      scopedTaskId: TASK_ID,
    });
    expect(scoped.status).toBe(200);
    expect(scoped.headers.get('content-type')).toBe('text/plain');
    expect(scoped.headers.get('content-disposition')).toContain("filename*=UTF-8''notes.txt");
    expect(await scoped.text()).toBe('private notes');
  });

  it('propagates session authorization failures before reading task metadata', async () => {
    uploadDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-task-attachments-'));
    const denied = Object.assign(new Error('Not authorized to view this session'), { code: 403 });

    const response = await callHandler({
      task: null,
      authorize: async () => {
        throw denied;
      },
    });

    expect(response.status).toBe(403);
  });

  it('rejects another session, invalid keys, symlink escapes, and unsupported MIME', async () => {
    uploadDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-task-attachments-'));
    const outsideDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-attachments-outside-'));
    const outsidePath = path.join(outsideDirectory, 'secret.png');
    await fs.writeFile(outsidePath, 'secret');
    await fs.symlink(outsidePath, path.join(uploadDirectory, 'escape.png'));

    const cases = [
      taskWith(attachment('escape.png')),
      taskWith(attachment('../secret.png')),
      taskWith(attachment('missing.png'), '018f0000-0000-7000-8000-000000000099'),
      taskWith(attachment('missing.svg', { mime_type: 'image/svg+xml' })),
    ];
    for (const task of cases) {
      const response = await callHandler({ task });
      expect(response.status).toBe(404);
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
    await fs.rm(outsideDirectory, { recursive: true, force: true });
  });
});
