/** Hosted OpenCode turn lifecycle: admission, restore, cleanup, and checkpointed completion. */

import { randomUUID } from 'node:crypto';
import { hostedCredentialFieldForProvider } from '@agor/agentic-tool-opencode';
import {
  assertOpenCodeCheckpointRuntime,
  discardOpenCodeScratch,
  type OpenCodeNativeStateLayout,
  prepareOpenCodeScratch,
  removeOpenCodeCheckpoints,
  resolveOpenCodeNativeStateLayout,
  restoreOpenCodeCheckpoint,
} from '@agor/agentic-tool-opencode/runtime';
import {
  isTerminalTaskStatus,
  type OpenCodeCheckpointAdmission,
  type OpenCodeCheckpointManifest,
  type SessionID,
  type Task,
  type TaskID,
  TaskStatus,
} from '@agor/core/types';
import type { AgorClient } from '../../services/feathers-client.js';
import { MissingCredentialError, resolveApiKeyForTask } from './base-executor.js';

const WRITE_ATTEMPTS = 4;
const RETRY_DELAY_MS = 1_000;

export interface ManagedOpenCodeTurn {
  holderId: string;
  layout: OpenCodeNativeStateLayout;
  input: OpenCodeCheckpointManifest | null;
  authContent: string;
  authSecrets: string[];
}

class FinalError extends Error {}

async function withRetries<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof FinalError || attempt >= WRITE_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
    }
  }
}

/** Returns null when another executor already holds this Task; the caller must exit quietly. */
export async function prepareManagedOpenCodeTurn(input: {
  client: AgorClient;
  sessionId: SessionID;
  taskId: TaskID;
  provider: string;
}): Promise<ManagedOpenCodeTurn | null> {
  const { client, taskId } = input;
  // Fail on an unusable image before admission or any credential read.
  await assertOpenCodeCheckpointRuntime();
  const layout = resolveOpenCodeNativeStateLayout({ sessionId: input.sessionId, taskId });
  const holderId = randomUUID();
  // A retry after a lost response replays the same admission for this holder.
  const admission: OpenCodeCheckpointAdmission = await withRetries(() =>
    client
      .service('tasks')
      .beginOpenCodeCheckpoint({ task_id: taskId, holder_instance_id: holderId })
  );
  if (admission.outcome === 'duplicate') return null;

  const field = hostedCredentialFieldForProvider(input.provider);
  if (!field) {
    throw new MissingCredentialError(
      `OpenCode provider ${input.provider} is not available in hosted workspaces.`
    );
  }
  const resolution = await resolveApiKeyForTask(field, client, taskId, 'opencode');
  if (resolution.decryptionFailed) {
    throw new Error(
      'A saved OpenCode provider key could not be decrypted. Re-enter it in Settings.'
    );
  }
  const connection = resolution.connection as Record<string, string | undefined> | undefined;
  const key = (connection?.[field] ?? resolution.apiKey)?.trim();
  if (!key) {
    throw new MissingCredentialError(
      `Save an API key for ${input.provider} in Settings > OpenCode to use it here.`
    );
  }
  const authContent = JSON.stringify({ [input.provider]: { type: 'api', key } });

  await prepareOpenCodeScratch(layout);
  try {
    if (admission.input) await restoreOpenCodeCheckpoint(layout, admission.input);
  } catch (error) {
    await discardOpenCodeScratch(layout).catch(() => undefined);
    throw error;
  }
  const removed = await removeOpenCodeCheckpoints(layout, admission.cleanup);
  // Cleanup bookkeeping never blocks a turn; unacknowledged rows are listed again later.
  await client
    .service('tasks')
    .acknowledgeOpenCodeCleanup({ task_id: taskId, holder_instance_id: holderId, deleted: removed })
    .catch(() => console.warn('[opencode] event=managed_cleanup_ack_deferred'));
  return {
    holderId,
    layout,
    input: admission.input,
    authContent,
    authSecrets: [key, authContent],
  };
}

/** Completion and acceptance share one daemon transaction, so a completed read-back means accepted. */
export async function completeManagedOpenCodeTurn(
  client: AgorClient,
  taskId: TaskID,
  patch: Partial<Task>,
  turn: ManagedOpenCodeTurn,
  checkpoint: OpenCodeCheckpointManifest
): Promise<void> {
  await withRetries(async () => {
    const current = (await client.service('tasks').get(taskId)) as Task;
    if (current.status === TaskStatus.COMPLETED) return;
    if (isTerminalTaskStatus(current.status) || current.status === TaskStatus.STOPPING) {
      throw new FinalError(`OpenCode completion was not accepted (task is ${current.status})`);
    }
    const updated = (await client.service('tasks').patch(taskId, {
      ...patch,
      opencode_checkpoint: { holder_instance_id: turn.holderId, manifest: checkpoint },
    } as Partial<Task>)) as Task;
    if (updated.status !== TaskStatus.COMPLETED) {
      throw new Error(`OpenCode completion was not accepted (task is ${updated.status})`);
    }
  });
}
