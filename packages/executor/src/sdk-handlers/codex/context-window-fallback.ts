import type { SessionID, TaskID } from '@agor/core/types';
import type { AgorClient } from '../../services/feathers-client.js';
import { extractCodexContextWindowUsage } from './usage.js';

type CodexTurnCounts = { inputTokens: number; outputTokens: number };

function extractCodexTurnCounts(rawSdkResponse: unknown): CodexTurnCounts | undefined {
  if (!rawSdkResponse || typeof rawSdkResponse !== 'object' || Array.isArray(rawSdkResponse)) {
    return undefined;
  }

  const raw = rawSdkResponse as Record<string, unknown>;
  const usage =
    raw.usage && typeof raw.usage === 'object' && !Array.isArray(raw.usage)
      ? (raw.usage as Record<string, unknown>)
      : raw;

  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens) || inputTokens < 0) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens:
      typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens >= 0
        ? outputTokens
        : 0,
  };
}

/**
 * Infer Codex context-window usage from running totals in turn.completed usage payloads.
 *
 * This tracks context occupancy at task end:
 * - Base inferred input occupancy (delta or current snapshot on reset)
 * - Plus current output tokens (new assistant content that is now in transcript)
 */
export function inferCodexContextWindowFromRunningTotals(
  currentRawSdkResponse: unknown,
  previousRawSdkResponse?: unknown
): number | undefined {
  const current = extractCodexTurnCounts(currentRawSdkResponse);
  if (!current) {
    return undefined;
  }

  const currentInputSnapshot = extractCodexContextWindowUsage(currentRawSdkResponse);
  if (!currentInputSnapshot || currentInputSnapshot <= 0) {
    return undefined;
  }

  const previous = extractCodexTurnCounts(previousRawSdkResponse);
  if (!previous) {
    return currentInputSnapshot + current.outputTokens;
  }

  if (current.inputTokens < previous.inputTokens) {
    // Counter reset/compaction: current snapshot becomes the new baseline.
    return currentInputSnapshot + current.outputTokens;
  }

  return Math.max(0, current.inputTokens - previous.inputTokens) + current.outputTokens;
}

type TaskRow = { task_id?: string; raw_sdk_response?: unknown };

function taskRowsFromFindResult(tasks: unknown): TaskRow[] {
  if (Array.isArray(tasks)) {
    return tasks as TaskRow[];
  }

  if (
    tasks &&
    typeof tasks === 'object' &&
    'data' in tasks &&
    Array.isArray((tasks as { data?: unknown }).data)
  ) {
    return (tasks as { data?: TaskRow[] }).data ?? [];
  }

  return [];
}

export async function computeCodexContextWindowFromPreviousTask(
  client: AgorClient,
  sessionId: SessionID,
  currentTaskId: TaskID,
  currentRawSdkResponse: unknown
): Promise<number | undefined> {
  const previousTask = await client.service('tasks').find({
    query: {
      session_id: sessionId,
      $sort: { created_at: -1 },
      $limit: 2,
    },
  });

  const taskRows = taskRowsFromFindResult(previousTask);
  const previousTaskRow = taskRows.find((task) => task.task_id !== currentTaskId);
  const previousRawSdkResponse = previousTaskRow?.raw_sdk_response;

  return inferCodexContextWindowFromRunningTotals(currentRawSdkResponse, previousRawSdkResponse);
}
