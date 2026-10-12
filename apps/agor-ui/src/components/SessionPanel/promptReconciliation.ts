import type { AgorClient, Task } from '@agor-live/client';
import {
  isInFlightConnectionLossError,
  withConnectionErrorDetail,
} from '../../utils/connectionErrors';
import { waitForConnectedClient } from './stopReconciliation';

export type PromptTransportReconciliation = 'landed' | 'unknown';

export const PROMPT_NOT_SENT_MESSAGE =
  "Couldn't send. The connection to Agor dropped, but your message is still in the box.";
export const PROMPT_OUTCOME_UNKNOWN_MESSAGE =
  'The connection to Agor dropped as you sent this. Check the conversation before sending it again.';

const RECENT_TASK_LIMIT = 20;

interface PromptAttempt {
  sessionId: string;
  userId: string;
  prompt: string;
}

/** Newest-id-first; a task id the daemon generates for a new prompt is a UUIDv7 that sorts above every existing id. */
async function findOwnTasks(
  client: AgorClient,
  attempt: PromptAttempt,
  limit: number,
  select: Array<keyof Task>
): Promise<Task[]> {
  const result = (await client.service('tasks').find({
    query: {
      session_id: attempt.sessionId,
      created_by: attempt.userId,
      $sort: { task_id: -1 },
      $limit: limit,
      $select: select,
    },
  })) as Task[] | { data: Task[] };
  return Array.isArray(result) ? result : result.data;
}

/** Never resends; only a matching task above the pre-send max id `baselineTaskId` (null: none existed) counts as landed. */
export async function reconcilePromptTransportFailure(
  getClient: () => AgorClient | null,
  attempt: PromptAttempt & { baselineTaskId: string | null },
  reconnectTimeoutMs = 2_000
): Promise<PromptTransportReconciliation> {
  const client = await waitForConnectedClient(getClient, reconnectTimeoutMs);
  if (!client) return 'unknown';

  try {
    const tasks = await findOwnTasks(client, attempt, RECENT_TASK_LIMIT, [
      'task_id',
      'session_id',
      'created_by',
      'full_prompt',
    ]);
    const landed = tasks.some(
      (task) =>
        task.session_id === attempt.sessionId &&
        task.created_by === attempt.userId &&
        task.full_prompt === attempt.prompt &&
        (attempt.baselineTaskId === null || task.task_id > attempt.baselineTaskId)
    );
    // No match may still mean the daemon is admitting it, so never claim it was not sent.
    return landed ? 'landed' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Resolves true when the prompt is known to have reached the session. */
export async function sendPromptWithReconciliation({
  send,
  getClient,
  attempt,
  showError,
  isCurrent = () => true,
  reconnectTimeoutMs,
}: {
  send: () => Promise<unknown>;
  getClient: () => AgorClient | null;
  attempt: PromptAttempt;
  showError: (message: string) => void;
  isCurrent?: () => boolean;
  reconnectTimeoutMs?: number;
}): Promise<boolean> {
  // Max existing task id, read from the server so an identical earlier prompt cannot pass for this one; undefined if unavailable.
  let baselineTaskId: string | null | undefined;
  const baselineClient = getClient();
  if (baselineClient) {
    try {
      const [newest] = await findOwnTasks(baselineClient, attempt, 1, ['task_id']);
      baselineTaskId = newest?.task_id ?? null;
    } catch (error) {
      if (isInFlightConnectionLossError(error)) {
        if (isCurrent()) showError(withConnectionErrorDetail(PROMPT_NOT_SENT_MESSAGE, error));
        return false;
      }
      // Any other failure only costs the landed check; the prompt is still sent.
    }
  }
  if (!isCurrent()) return false;

  try {
    await send();
    return isCurrent();
  } catch (error) {
    console.error('Prompt error:', error);
    if (!isInFlightConnectionLossError(error)) {
      if (isCurrent()) {
        showError(
          `Failed to send prompt: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return false;
    }
    const outcome =
      baselineTaskId === undefined
        ? 'unknown'
        : await reconcilePromptTransportFailure(
            getClient,
            { ...attempt, baselineTaskId },
            reconnectTimeoutMs
          );
    if (!isCurrent()) return false;
    if (outcome === 'landed') return true;
    showError(withConnectionErrorDetail(PROMPT_OUTCOME_UNKNOWN_MESSAGE, error));
    return false;
  }
}
