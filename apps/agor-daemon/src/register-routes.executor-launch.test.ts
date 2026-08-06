import type { Task, UserID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { buildExecuteTaskData } from './register-routes.js';

const OWNER_ID = '019fd901-0000-7000-8000-000000000001' as UserID;
const PROMPTER_ID = '019fd901-0000-7000-8000-000000000002' as UserID;

describe('common task executor launch data', () => {
  it.each([
    { path: 'direct', status: TaskStatus.CREATED, source: undefined },
    { path: 'queued gateway', status: TaskStatus.QUEUED, source: 'gateway' as const },
  ])('keeps task creator B authoritative for $path launches', ({ status, source }) => {
    const task = {
      task_id: '019fd901-0000-7000-8000-000000000003',
      session_id: '019fd901-0000-7000-8000-000000000004',
      created_by: PROMPTER_ID,
      status,
      full_prompt: 'Original task prompt',
      metadata: source ? { source, queued_by_user_id: OWNER_ID } : undefined,
    } as Task;

    expect(
      buildExecuteTaskData(task, '[Prompted by: Prompter B]\n\nOriginal task prompt', {
        stream: true,
        messageSource: source,
      })
    ).toEqual({
      taskId: task.task_id,
      prompterUserId: PROMPTER_ID,
      prompt: '[Prompted by: Prompter B]\n\nOriginal task prompt',
      permissionMode: undefined,
      stream: true,
      messageSource: source,
    });
  });
});
