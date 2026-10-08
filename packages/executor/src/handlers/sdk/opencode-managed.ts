/** Hosted OpenCode turn lifecycle: admission, restore, cleanup, and checkpointed completion. */

import {
  assertOpenCodeCheckpointRuntime,
  discardOpenCodeScratch,
  type OpenCodeNativeStateLayout,
  prepareOpenCodeScratch,
  removeOpenCodeCheckpoints,
  resolveOpenCodeNativeStateLayout,
  restoreOpenCodeCheckpoint,
} from '@agor/agentic-tool-opencode/runtime';
import { generateId } from '@agor/core/db';
import {
  isTerminalTaskStatus,
  missingOpenCodeApiKeyMessage,
  type OpenCodeCheckpointAdmission,
  type OpenCodeCheckpointManifest,
  type SessionID,
  type SessionSdkHomeScope,
  type Task,
  type TaskID,
  TaskStatus,
} from '@agor/core/types';
import type { AgorClient } from '../../services/feathers-client.js';
import { MissingCredentialError } from './base-executor.js';

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
  sdkHomeScope: SessionSdkHomeScope;
  provider: string;
}): Promise<ManagedOpenCodeTurn | null> {
  const { client, taskId } = input;
  // Fail on an unusable image before admission or any credential read.
  await assertOpenCodeCheckpointRuntime();
  const layout = resolveOpenCodeNativeStateLayout({
    sessionId: input.sessionId,
    taskId,
    sdkHomeScope: input.sdkHomeScope,
  });
  const holderId = generateId();
  // A retry after a lost response replays the same admission for this holder.
  const admission: OpenCodeCheckpointAdmission = await withRetries(() =>
    client
      .service('tasks')
      .beginOpenCodeCheckpoint({ task_id: taskId, holder_instance_id: holderId })
  );
  if (admission.outcome === 'duplicate') return null;

  const key = admission.providerKey?.key;
  if (!key || admission.providerKey?.providerId !== input.provider.trim()) {
    throw new MissingCredentialError(missingOpenCodeApiKeyMessage(input.provider));
  }
  const authContent = JSON.stringify({ [input.provider.trim()]: { type: 'api', key } });

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
  checkpoint: OpenCodeCheckpointManifest,
  shouldSkipCompletion: () => boolean
): Promise<void> {
  await withRetries(async () => {
    const current = (await client.service('tasks').get(taskId)) as Task;
    if (current.status === TaskStatus.COMPLETED) {
      // A terminal re-patch lets the service retry credential retirement if the first one failed.
      await client.service('tasks').patch(taskId, { status: TaskStatus.COMPLETED });
      return;
    }
    if (isTerminalTaskStatus(current.status) || current.status === TaskStatus.STOPPING) {
      throw new FinalError(`OpenCode completion was not accepted (task is ${current.status})`);
    }
    // Stop can win during the read or a retry delay; the daemon then owns terminality.
    if (shouldSkipCompletion()) return;
    const updated = (await client.service('tasks').patch(taskId, {
      ...patch,
      opencode_checkpoint: { holder_instance_id: turn.holderId, manifest: checkpoint },
    } as Partial<Task>)) as Task;
    if (updated.status !== TaskStatus.COMPLETED) {
      throw new Error(`OpenCode completion was not accepted (task is ${updated.status})`);
    }
  });
}
