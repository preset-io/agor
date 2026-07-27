import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Task, TaskAttachment } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgorClient } from './services/feathers-client';
import { materializeTaskAttachments } from './task-attachments';

const SESSION_ID = '018f0000-0000-7000-8000-000000000001';
const TASK_ID = '018f0000-0000-7000-8000-000000000002';
const TOKEN = 'executor-task-token';

let storageRoot: string;

beforeEach(async () => {
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-executor-attachments-'));
});

afterEach(async () => {
  await fs.rm(storageRoot, { recursive: true, force: true });
});

function clientFor(task: Task): AgorClient {
  return {
    service: vi.fn(() => ({ get: vi.fn(async () => task) })),
  } as unknown as AgorClient;
}

function task(attachments: TaskAttachment[] = []): Task {
  return {
    task_id: TASK_ID,
    session_id: SESSION_ID,
    full_prompt: 'Compare these files',
    metadata: { attachments },
  } as Task;
}

describe('materializeTaskAttachments', () => {
  it('retrieves every attachment with the task token and derives an executor-only prompt', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('chart bytes', { headers: { 'content-type': 'image/png' } })
      )
      .mockResolvedValueOnce(new Response('notes', { headers: { 'content-type': 'text/plain' } }));

    const result = await materializeTaskAttachments({
      client: clientFor(
        task([
          { storage_key: 'chart_123.png', filename: 'chart.png', mime_type: 'image/png' },
          {
            storage_key: 'notes_123.txt',
            filename: '../../notes.txt',
            mime_type: 'text/plain',
          },
        ])
      ),
      daemonUrl: 'http://daemon.test:3030',
      sessionToken: TOKEN,
      sessionId: SESSION_ID,
      taskId: TASK_ID,
      prompt: '[Prompted by: teammate]\n\nCompare these files',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      storageRoot,
    });

    expect(result.userPrompt).toBe('Compare these files');
    expect(result.executionPrompt).toContain('Attached files:');
    expect(result.executionPrompt).toContain('[Prompted by: teammate]\n\nCompare these files');
    expect(result.executionPrompt).not.toContain('chart_123.png');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      new URL(`http://daemon.test:3030/sessions/${SESSION_ID}/tasks/${TASK_ID}/attachments/0`),
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    );

    const localPaths = result.executionPrompt
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2));
    expect(localPaths.map((localPath) => path.basename(localPath))).toEqual([
      '01-chart.png',
      '02-notes.txt',
    ]);
    expect(await fs.readFile(localPaths[0], 'utf8')).toBe('chart bytes');
    expect(await fs.readFile(localPaths[1], 'utf8')).toBe('notes');
  });

  it('leaves non-attachment execution and stored prompts unchanged', async () => {
    const fetchImpl = vi.fn();

    const result = await materializeTaskAttachments({
      client: clientFor(task()),
      daemonUrl: 'http://daemon.test:3030',
      sessionToken: TOKEN,
      sessionId: SESSION_ID,
      taskId: TASK_ID,
      prompt: 'Run the focused tests',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      storageRoot,
    });

    expect(result).toEqual({
      userPrompt: 'Compare these files',
      executionPrompt: 'Run the focused tests',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails the turn clearly and removes partial copies when any retrieval fails', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('first', { headers: { 'content-type': 'image/png' } }))
      .mockResolvedValueOnce(new Response('missing', { status: 404 }));

    await expect(
      materializeTaskAttachments({
        client: clientFor(
          task([
            { storage_key: 'first.png', filename: 'first.png', mime_type: 'image/png' },
            { storage_key: 'second.png', filename: 'second.png', mime_type: 'image/png' },
          ])
        ),
        daemonUrl: 'http://daemon.test:3030',
        sessionToken: TOKEN,
        sessionId: SESSION_ID,
        taskId: TASK_ID,
        prompt: 'Compare',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        storageRoot,
      })
    ).rejects.toThrow(
      'Failed to materialize task attachments: attachment 2 retrieval returned HTTP 404'
    );
    expect(await fs.readdir(storageRoot)).toEqual([]);
  });
});
