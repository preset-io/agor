import * as NativeOpenCodeRuntime from '@agor/agentic-tool-opencode/runtime';
import type { TaskID } from '@agor/core/types';
import type { AgorClient } from '../../services/feathers-client.js';

type CleanupWork =
  | { kind: 'delete'; object: { storeId: string; taskId: string } }
  | { kind: 'observe'; attemptId: string }
  | { kind: 'none' };

interface ManagedOpenCodeNativeStateLayout {
  homeDir: string;
  namespaceKey: string;
  agorSessionId: string;
  storeId: string;
  attemptsDir: string;
  attemptTaskId: string;
  scratchRoot: string;
  liveDbPath: string;
  xdg: { data: string; config: string; cache: string; state: string };
}

interface OpenCodeNativeStateService {
  prepareCleanup(input: { task_id: string; holder_instance_id: string }): Promise<CleanupWork>;
  observe(input: {
    task_id: string;
    holder_instance_id: string;
    attempt_id: string;
  }): Promise<void>;
  acknowledgeDelete(input: {
    task_id: string;
    holder_instance_id: string;
    object: { storeId: string; taskId: string };
    result: { outcome: 'deleted' } | { outcome: 'failed'; errorCode: string };
  }): Promise<void>;
}

/**
 * One launch issues at most one cleanup operation. A successful reservation is
 * dispatched even if its RPC consumed the selection budget; no batch is
 * prefetched past the first unstarted eligible item.
 */
export class OpenCodeCleanupOperation {
  private operation: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly client: AgorClient,
    private readonly taskId: TaskID,
    private readonly holderId: string,
    private readonly layout: ManagedOpenCodeNativeStateLayout
  ) {}

  start(): void {
    if (this.operation || this.stopped) return;
    this.operation = this.reserveAndDispatch().catch((error) => {
      console.warn('[opencode.cleanup] event=operation_deferred reason=service_unavailable');
      // The row remains due or permanently tombstoned; the next launch retries.
      void error;
    });
  }

  stopScheduling(): void {
    this.stopped = true;
  }

  /** Stop accepts no further reservation and waits for an already committed operation. */
  async stopAndDrain(): Promise<void> {
    this.stopScheduling();
    await this.operation;
  }

  private service(): OpenCodeNativeStateService {
    return this.client.service(
      'opencode-native-state' as string
    ) as unknown as OpenCodeNativeStateService;
  }

  private async reserveAndDispatch(): Promise<void> {
    const deadline = Date.now() + 250;
    if (this.stopped || Date.now() >= deadline) return;
    const service = this.service();
    const work = await service.prepareCleanup({
      task_id: this.taskId,
      holder_instance_id: this.holderId,
    });
    if (work.kind === 'none') return;
    // A committed work item is dispatched even if the reservation reply was
    // delayed beyond the selection budget.
    if (work.kind === 'observe') {
      await service.observe({
        task_id: this.taskId,
        holder_instance_id: this.holderId,
        attempt_id: work.attemptId,
      });
      return;
    }
    if (work.object.storeId !== this.layout.storeId) {
      console.error('[opencode.cleanup] event=delete_skipped reason=store_mismatch');
      return;
    }
    const deleteWorker = (
      NativeOpenCodeRuntime as unknown as {
        deleteRetiredOpenCodeAttemptInWorker(
          layout: ManagedOpenCodeNativeStateLayout,
          object: { storeId: string; taskId: string }
        ): Promise<{ outcome: 'deleted' } | { outcome: 'failed'; errorCode: string }>;
      }
    ).deleteRetiredOpenCodeAttemptInWorker;
    const result = await deleteWorker(this.layout, work.object);
    await service.acknowledgeDelete({
      task_id: this.taskId,
      holder_instance_id: this.holderId,
      object: work.object,
      result,
    });
  }
}
