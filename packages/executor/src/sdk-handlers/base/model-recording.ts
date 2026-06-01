/**
 * Helpers for recording the model that actually ran on Task / Message rows.
 *
 * Contract: record the user's *configured* model (or the SDK's echoed model
 * when available). Never substitute `DEFAULT_<TOOL>_MODEL` — that lies on
 * sessions where the user hasn't picked. SDK invocation may fall back to a
 * default (it needs a string); recording must stay honest.
 */

import type { Message } from '@agor/core/types';
import type { TokenUsage } from '../../types/token-usage.js';
import type { TasksService } from './service-clients.js';

/**
 * Build assistant-message metadata; omits `model` key when unknown.
 */
export function buildAssistantMessageMetadata(args: {
  model?: string;
  tokenUsage?: TokenUsage;
}): NonNullable<Message['metadata']> {
  return {
    ...(args.model ? { model: args.model } : {}),
    tokens: {
      input: args.tokenUsage?.input_tokens ?? 0,
      output: args.tokenUsage?.output_tokens ?? 0,
    },
  };
}

/**
 * Patch `Task.model` from the per-message create flow. No-op when any input
 * is missing — leaves the field for base-executor's post-turn patch.
 */
export async function patchTaskModelIfKnown(
  tasksService: TasksService | undefined,
  taskId: string | undefined,
  model: string | undefined
): Promise<void> {
  if (!tasksService || !taskId || !model) return;
  await tasksService.patch(taskId, { model });
}
