import { getBaseUrl } from '@agor/core/config';
import {
  BranchRepository,
  bindRepositoryToTenantUnitOfWork,
  CompletionSubscriptionRepository,
  runWithSystemDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  shortId,
  TaskRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  CompletionSubscription,
  CompletionSubscriptionID,
  CompletionTerminalSnapshot,
  Message,
  MessageID,
  Session,
  Task,
  TaskMetadata,
  TenantContext,
  User,
} from '@agor/core/types';
import { isTerminalTaskStatus, TaskStatus } from '@agor/core/types';
import { ensureCanPromptTargetSession } from '../utils/branch-authorization.js';
import { propagatedCompletionCallbackTaskId } from '../utils/durable-task-id.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import { lockTenantAuthorizationFence } from './tenant-authorization-fence.js';

const SCAN_BATCH = 100;
const SCAN_INTERVAL_MS = 5_000;

export function completionTerminalStatusForTask(
  task: Pick<Task, 'status'>
): CompletionTerminalSnapshot['status'] {
  if (task.status === TaskStatus.COMPLETED) return 'completed';
  if (task.status === TaskStatus.TIMED_OUT) return 'timed_out';
  if (task.status === TaskStatus.STOPPED) return 'cancelled';
  return 'failed';
}

function boundedErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : 'unknown';
  return name.replaceAll(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 96) || 'unknown';
}

function messageText(message: Message | undefined): string | undefined {
  if (!message) return undefined;
  if (typeof message.content === 'string') return message.content.slice(0, 40_000);
  if (!Array.isArray(message.content)) return undefined;
  const value = message.content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        !Array.isArray(block) &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
    )
    .map((block) => block.text)
    .join('\n\n')
    .trim();
  return value ? value.slice(0, 40_000) : undefined;
}

export function renderTerminalCallback(input: {
  subscription: CompletionSubscription;
  terminalSession?: Session;
  terminalResult?: string;
  branchUrl?: string | null;
  issueUrl?: string;
  pullRequestUrl?: string;
  authorized: boolean;
}): string {
  const { subscription, authorized } = input;
  const terminal = subscription.terminal_snapshot!;
  const lines = [
    `[Agor] Delegated work reached terminal state: **${terminal.status}**.`,
    '',
    `**Completion subscription:** ${subscription.subscription_id}`,
    `**Origin session/task:** ${subscription.origin_session_id} / ${subscription.origin_task_id}`,
    `**Requested at:** ${subscription.created_at}`,
    `**Completed at:** ${terminal.completed_at}`,
  ];
  if (subscription.delegated_at) lines.push(`**Last delegated at:** ${subscription.delegated_at}`);
  if (authorized) {
    lines.push(
      `**Terminal session/task:** ${terminal.session_id} / ${terminal.task_id}`,
      `**Delegation path:** ${subscription.path
        .map((hop) => `${shortId(hop.session_id)}/${shortId(hop.task_id)}`)
        .join(' → ')}`
    );
    const sessionUrl = input.terminalSession?.url;
    if (sessionUrl) lines.push(`**Session:** ${sessionUrl}`);
    if (terminal.branch_id) lines.push(`**Branch ID:** ${terminal.branch_id}`);
    if (input.branchUrl) lines.push(`**Branch:** ${input.branchUrl}`);
    if (input.issueUrl) lines.push(`**Issue:** ${input.issueUrl}`);
    if (input.pullRequestUrl) lines.push(`**Pull request:** ${input.pullRequestUrl}`);
  } else {
    lines.push(
      '**Terminal details:** omitted because the requesting user no longer has access to the downstream branch.'
    );
  }
  if (authorized && terminal.reason) lines.push(`**Reason:** ${terminal.reason}`);
  if (authorized && input.terminalResult) {
    lines.push('', '**Final result:**', input.terminalResult);
  }
  lines.push(
    '',
    `Query authoritative status with \`agor_completion_subscriptions_get\` and subscriptionId \`${subscription.subscription_id}\`.`
  );
  return lines.join('\n');
}

export function completionCallbackTaskMetadata(input: {
  subscription: CompletionSubscription;
  terminal: CompletionTerminalSnapshot;
  deliveryTaskId: Task['task_id'];
  authorized: boolean;
}): TaskMetadata {
  return {
    is_agor_callback: true,
    source: 'agor',
    queued_by_user_id: input.subscription.requested_by_user_id,
    completion_subscription_id: input.subscription.subscription_id,
    initial_message_id: input.deliveryTaskId as MessageID,
    ...(input.authorized
      ? {
          child_session_id: input.terminal.session_id,
          child_task_id: input.terminal.task_id,
        }
      : {}),
  };
}

export interface CompletionSubscriptionWorkerOptions {
  tenantId?: string;
  intervalMs?: number;
}

/**
 * Durable reconciliation/outbox loop. Polling is only for crash recovery and
 * retrying committed delivery intents; downstream work itself is event-driven.
 */
export class CompletionSubscriptionWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly app: Application,
    private readonly options: CompletionSubscriptionWorkerOptions = {}
  ) {}

  start(): void {
    if (this.timer || this.running) return;
    this.stopped = false;
    this.schedule(0);
    console.log('[completion-callback] event=worker_started');
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    console.log('[completion-callback] event=worker_stopped');
  }

  wake(): void {
    if (this.stopped || this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runLoop();
    }, delay);
    this.timer.unref?.();
  }

  private async runLoop(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      await this.checkOnce();
    } catch (error) {
      console.warn(`[completion-callback] event=scan_failed code=${boundedErrorCode(error)}`);
    } finally {
      this.running = false;
      this.schedule(this.options.intervalMs ?? SCAN_INTERVAL_MS);
    }
  }

  private async discover(kind: 'active' | 'due') {
    const repo = new CompletionSubscriptionRepository(this.db);
    const find = (scoped: import('@agor/core/db').TenantScopedDatabase) =>
      kind === 'active'
        ? repo.findActiveRefs(scoped, { limit: SCAN_BATCH })
        : repo.findDueRefs(scoped, { limit: SCAN_BATCH });
    if (this.options.tenantId) {
      return runWithTenantDatabaseScope(this.db, this.options.tenantId, find);
    }
    return runWithSystemDatabaseScope(
      this.db,
      `completion callback ${kind} discovery`,
      (systemDb) =>
        kind === 'active'
          ? repo.findActiveRefs(systemDb, { limit: SCAN_BATCH })
          : repo.findDueRefs(systemDb, { limit: SCAN_BATCH }),
      { capability: 'completion_callback_discovery' }
    );
  }

  async checkOnce(): Promise<{ reconciled: number; delivered: number }> {
    const activeRefs = await this.discover('active');
    for (const ref of activeRefs) {
      const tenantId = this.options.tenantId ?? ref.tenant_id;
      try {
        await runWithTenantContext(tenantId, () =>
          runWithTenantDatabaseScope(this.db, tenantId, () => this.reconcile(ref.subscription_id))
        );
      } catch (error) {
        // One poisoned reference must not block reconciliation of the rest of
        // the batch, or the due-delivery pass below, until the next scan.
        console.warn(
          `[completion-callback] event=reconcile_failed subscription_id=${shortId(ref.subscription_id)} code=${boundedErrorCode(error)}`
        );
      }
    }
    const dueRefs = await this.discover('due');
    for (const ref of dueRefs) {
      const tenantId = this.options.tenantId ?? ref.tenant_id;
      try {
        await runWithTenantContext(tenantId, () =>
          runWithTenantDatabaseScope(this.db, tenantId, () =>
            this.deliver(ref.subscription_id, tenantId)
          )
        );
      } catch (error) {
        // deliver() already records failures durably via recordDeliveryFailure;
        // this only guards against a failure so early it never reached that
        // handler (e.g. discovery/tenant-scope setup).
        console.warn(
          `[completion-callback] event=deliver_failed subscription_id=${shortId(ref.subscription_id)} code=${boundedErrorCode(error)}`
        );
      }
    }
    return { reconciled: activeRefs.length, delivered: dueRefs.length };
  }

  private repositories() {
    return {
      subscriptions: bindRepositoryToTenantUnitOfWork(
        this.db,
        new CompletionSubscriptionRepository(this.db)
      ),
      tasks: bindRepositoryToTenantUnitOfWork(this.db, new TaskRepository(this.db)),
      branches: bindRepositoryToTenantUnitOfWork(this.db, new BranchRepository(this.db)),
    };
  }

  private async reconcile(id: CompletionSubscriptionID): Promise<void> {
    const { subscriptions, tasks } = this.repositories();
    const subscription = await subscriptions.get(id);
    if (!subscription.active_task_id) {
      await subscriptions.markMissingActive(id, null);
      console.warn(`[completion-callback] event=downstream_missing subscription_id=${shortId(id)}`);
      return;
    }
    const task = await tasks.findById(subscription.active_task_id);
    if (!task) {
      await subscriptions.markMissingActive(id, subscription.active_task_id);
      console.warn(`[completion-callback] event=downstream_missing subscription_id=${shortId(id)}`);
      return;
    }
    if (!isTerminalTaskStatus(task.status)) {
      if (![TaskStatus.CREATED, TaskStatus.QUEUED].includes(task.status as never)) {
        await subscriptions.markRunningForTask(task.task_id);
      }
      return;
    }
    const terminalHop = subscription.path.at(-1);
    await subscriptions.markTerminalForTask(task.task_id, {
      session_id: task.session_id,
      task_id: task.task_id,
      ...(terminalHop?.branch_id ? { branch_id: terminalHop.branch_id } : {}),
      status: completionTerminalStatusForTask(task),
      completed_at: task.completed_at ?? new Date().toISOString(),
      ...(task.error_message ? { reason: task.error_message.slice(0, 2_000) } : {}),
    });
    console.log(
      `[completion-callback] event=terminal_captured subscription_id=${shortId(id)} status=${completionTerminalStatusForTask(task)}`
    );
  }

  private async deliver(id: CompletionSubscriptionID, tenantId: string): Promise<void> {
    const { subscriptions, branches } = this.repositories();
    const subscription = await subscriptions.get(id);
    const terminal = subscription.terminal_snapshot;
    const callbackSessionId = subscription.callback_session_id;
    if (!terminal || !callbackSessionId) {
      await subscriptions.recordDeliveryFailure(id, 'callback_target_missing');
      return;
    }

    try {
      const user = (await this.app.service('users').get(subscription.requested_by_user_id, {
        provider: undefined,
      })) as User;
      const tenant = { tenant_id: tenantId } as TenantContext;
      const userParams = {
        authenticated: true,
        provider: 'mcp',
        user,
        tenant,
      } as AuthenticatedParams;
      // Low-latency rejection before any enrichment work. The authoritative
      // check is repeated inside the admission transaction below, exactly
      // like /sessions/:id/prompt: a durable delivery can be arbitrarily
      // delayed, so authority must be re-verified at the moment of Task
      // creation, not only at the start of this pass.
      const callbackSession = await ensureCanPromptTargetSession(
        callbackSessionId,
        subscription.requested_by_user_id,
        this.app,
        branches
      );

      let terminalSession: Session | undefined;
      let terminalResult: string | undefined;
      let branchUrl: string | null | undefined;
      let issueUrl: string | undefined;
      let pullRequestUrl: string | undefined;
      let authorized = false;
      try {
        terminalSession = (await this.app
          .service('sessions')
          .get(terminal.session_id, userParams)) as Session;
        await this.app.service('tasks').get(terminal.task_id, userParams);
        authorized = true;
        try {
          const result = await this.app.service('messages').find({
            ...userParams,
            query: {
              session_id: terminal.session_id,
              task_id: terminal.task_id,
              role: 'assistant',
              $sort: { index: -1 },
              $limit: 1,
            },
          });
          const messages = Array.isArray(result) ? result : result.data;
          terminalResult = messageText(messages[0]);
        } catch {
          // The terminal status and identity remain useful when the final
          // assistant message was deleted or is unavailable.
        }
        if (terminalSession.branch_id) {
          try {
            const branch = await this.app
              .service('branches')
              .get(terminalSession.branch_id, userParams);
            branchUrl = branch.url;
            issueUrl = branch.issue_url;
            pullRequestUrl = branch.pull_request_url;
          } catch {
            // Branch enrichment is optional and remains permission-gated.
          }
        }
      } catch {
        // Terminal outcome remains deliverable; private descendant details do not.
      }

      // Resolve configured browser origin even when legacy rows lack enriched URLs.
      if (authorized && terminalSession && !terminalSession.url) {
        terminalSession = {
          ...terminalSession,
          url: `${await getBaseUrl()}/ui/s/${shortId(terminalSession.session_id)}/`,
        };
      }
      const prompt = renderTerminalCallback({
        subscription,
        terminalSession,
        terminalResult,
        branchUrl,
        issueUrl,
        pullRequestUrl,
        authorized,
      });
      const deliveryTaskId = propagatedCompletionCallbackTaskId(
        subscription.subscription_id,
        callbackSession.session_id
      );
      // Re-authorize and admit the durable delivery Task in the same
      // transaction, under the same tenant authorization fence used by
      // /sessions/:id/prompt admission. This closes the gap where a branch
      // capability revocation commits between the fast-path check above and
      // Task creation. A deterministic-insert collision with another worker
      // is left to abort this transaction and surface through the outer
      // catch below; recordDeliveryFailure's retry will observe the winner's
      // already-committed row as `existing` on the next attempt.
      const { callbackTask, created } = await runWithTenantDatabaseTransaction(
        this.db,
        tenantId,
        async (operationDb) => {
          await lockTenantAuthorizationFence(operationDb, userParams);
          await ensureCanPromptTargetSession(
            callbackSessionId,
            subscription.requested_by_user_id,
            this.app,
            new BranchRepository(operationDb)
          );
          const operationTasks = new TaskRepository(operationDb);
          const existing = await operationTasks.findById(deliveryTaskId);
          if (existing) {
            if (
              existing.session_id !== callbackSession.session_id ||
              existing.metadata?.completion_subscription_id !== subscription.subscription_id
            ) {
              throw new Error('Durable completion delivery key collision');
            }
            return { callbackTask: existing, created: false };
          }
          const admitted = await operationTasks.createPending({
            task_id: deliveryTaskId,
            session_id: callbackSession.session_id,
            full_prompt: prompt,
            created_by: subscription.requested_by_user_id,
            status: TaskStatus.QUEUED,
            metadata: completionCallbackTaskMetadata({
              subscription,
              terminal,
              deliveryTaskId,
              authorized,
            }),
          });
          return { callbackTask: admitted, created: true };
        }
      );
      await subscriptions.recordDelivered(id, callbackTask.task_id);
      if (created) {
        emitServiceEvent(this.app, {
          path: 'tasks',
          event: 'queued',
          method: 'create',
          data: callbackTask,
          id: callbackTask.task_id,
          params: userParams,
        });
      }
      const sessionsService = this.app.service('sessions') as unknown as {
        triggerQueueProcessing(sessionId: string, params?: AuthenticatedParams): Promise<void>;
      };
      await sessionsService.triggerQueueProcessing(callbackSession.session_id, userParams);
      console.log(
        `[completion-callback] event=delivered subscription_id=${shortId(id)} delivery_task_id=${shortId(callbackTask.task_id)}`
      );
    } catch (error) {
      const failed = await subscriptions.recordDeliveryFailure(id, boundedErrorCode(error));
      if (failed.state === 'delivered') {
        console.warn(
          `[completion-callback] event=queue_trigger_deferred subscription_id=${shortId(id)} delivery_task_id=${failed.delivery_task_id ? shortId(failed.delivery_task_id) : 'unknown'}`
        );
      } else {
        console.warn(
          `[completion-callback] event=delivery_failed subscription_id=${shortId(id)} attempt=${failed.delivery_attempt_count} code=${failed.last_delivery_error_code}`
        );
      }
    }
  }
}
