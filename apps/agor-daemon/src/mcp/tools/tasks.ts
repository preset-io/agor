import { type TaskID, TaskStatus } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { TasksService } from '../../services/tasks.js';
import { resolveSessionId } from '../resolve-ids.js';
import { mcpListLimit, mcpOffset, mcpOptionalId, mcpPageResult, mcpRequiredId } from '../schema.js';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';

export function registerTaskTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_tasks_list
  server.registerTool(
    'agor_tasks_list',
    {
      description:
        'List a page of tasks (user prompts), optionally in one session. Use status=queued with sessionId to find pending full task IDs in queue order. Advance with offset=nextOffset while hasMore is true.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        sessionId: mcpOptionalId('sessionId', 'Session', 'Session ID to get tasks from'),
        status: z
          .literal(TaskStatus.QUEUED)
          .optional()
          .describe('Return only pending tasks, ordered by queue_position'),
        limit: mcpListLimit(),
        offset: mcpOffset(),
      }),
    },
    async (args) => {
      const limit = args.limit ?? 25;
      const offset = args.offset ?? 0;
      const query: Record<string, unknown> = {};
      if (args.sessionId) query.session_id = await resolveSessionId(ctx, args.sessionId);
      query.$limit = limit;
      query.$skip = offset;
      if (args.status) query.status = args.status;
      query.$sort =
        args.status === TaskStatus.QUEUED
          ? { queue_position: 1, task_id: 1 }
          : { created_at: -1, task_id: 1 };
      const tasks = await ctx.app.service('tasks').find({ query, ...ctx.baseServiceParams });
      return textResult(mcpPageResult(tasks, limit, offset));
    }
  );

  // Tool 2: agor_tasks_get
  server.registerTool(
    'agor_tasks_get',
    {
      description: 'Get detailed information about a specific task',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        taskId: mcpRequiredId('taskId', 'Task'),
      }),
    },
    async (args) => {
      const task = await ctx.app.service('tasks').get(args.taskId, ctx.baseServiceParams);
      return textResult(task);
    }
  );

  const taskIds = z
    .array(z.uuid())
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate task IDs are not allowed');
  const outputSchema = z.object({
    session_id: z.uuid(),
    queue: z.array(z.object({ task_id: z.uuid(), queue_position: z.number().int() })),
    cancelled_task_ids: z.array(z.uuid()),
  });
  server.registerTool(
    'agor_tasks_cancel_queued',
    {
      description:
        'Cancel selected queued task IDs in one explicitly named session, atomically removing them without stopping active work or sending completion callbacks. Requires the same Branch Manager permission as task deletion. Only queued tasks qualify; any ineligible ID rejects the whole batch. Returns the resulting queue. On conflict reread agor_tasks_list with status=queued and retry. For urgent replacement of active work, capture the original active task ID, then first enqueue the update with agor_sessions_prompt (mode=continue), inspect/re-read the queue and cancel obsolete queued tasks, then use agor_tasks_reorder_queued with expectedTaskIds to move the update to the front; ONLY THEN agor_sessions_stop with expectedTaskId set to that original active task ID and a reason. Stop preserves/drains the queue, so stopping first risks dispatching stale work. If the original finishes and the update starts, expectedTaskId protects the update: on condition_changed re-read and reassess, never fall back to an unconditional stop. These separate calls are not atomic; re-read on unexpected dispatch/queue changes.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      inputSchema: z.object({
        sessionId: mcpRequiredId('sessionId', 'Session'),
        taskIds: taskIds
          .refine((ids) => ids.length > 0, 'Select at least one queued task')
          .describe('Full UUIDs from agor_tasks_list'),
      }),
      outputSchema,
    },
    async (args) => {
      const result = await (ctx.app.service('tasks') as unknown as TasksService).cancelQueued(
        {
          session_id: await resolveSessionId(ctx, args.sessionId),
          task_ids: args.taskIds as TaskID[],
        },
        ctx.baseServiceParams
      );
      return { ...textResult(result), structuredContent: { ...result } };
    }
  );
  server.registerTool(
    'agor_tasks_reorder_queued',
    {
      description:
        'Reorder all pending tasks in one explicitly named session without touching active work. Requires Branch Manager permission, like task deletion. expectedTaskIds must match the current ordered queue exactly; taskIds must be its exact permutation. Enqueue, dispatch, cancellation or another reorder can cause a conflict: reread agor_tasks_list with status=queued and retry. Never resumes a failure-held queue. Returns the resulting queue. For urgent replacement of active work, capture the original active task ID, then first enqueue updated instructions with agor_sessions_prompt (mode=continue) while the child is active, inspect/re-read the queue, and remove obsolete queued tasks with agor_tasks_cancel_queued. Move the update to the front here using expectedTaskIds; ONLY THEN agor_sessions_stop with expectedTaskId set to that original active task ID and a reason, because stop preserves/drains the queue and stopping first risks dispatching stale work. The update is a next turn after verified termination, not in-place injection or guaranteed instantaneous delivery. Accepted/pending stop is not confirmed termination. If the original finishes and the update starts, expectedTaskId protects the update: on condition_changed re-read and reassess, never fall back to an unconditional stop. These separate calls are not atomic; on conflicts or unexpected dispatch/queue changes re-read and reassess. Existing running-task edits are preserved, not rolled back.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: z.object({
        sessionId: mcpRequiredId('sessionId', 'Session'),
        expectedTaskIds: taskIds.describe('All current queued full UUIDs in observed queue order'),
        taskIds: taskIds.describe(
          'The same full UUIDs in desired dispatch order; no omissions or additions'
        ),
      }),
      outputSchema,
    },
    async (args) => {
      const result = await (ctx.app.service('tasks') as unknown as TasksService).reorderQueued(
        {
          session_id: await resolveSessionId(ctx, args.sessionId),
          expected_task_ids: args.expectedTaskIds as TaskID[],
          task_ids: args.taskIds as TaskID[],
        },
        ctx.baseServiceParams
      );
      return { ...textResult(result), structuredContent: { ...result } };
    }
  );
}
