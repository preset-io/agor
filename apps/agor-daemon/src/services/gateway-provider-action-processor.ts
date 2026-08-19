import type { DistributedWorkIdentity } from '@agor/core/coordination';
import { type GatewayProviderActionRepository, generateId } from '@agor/core/db';
import type {
  GatewayChannelID,
  GatewayProviderAction,
  GatewayProviderActionResultMetadata,
  TenantID,
} from '@agor/core/types';

export interface GatewayProviderActionOwner {
  tenantId: TenantID | string;
  channelId: GatewayChannelID;
  listenerClaimToken: string;
  listenerGeneration: number;
}

export type GatewayProviderActionExecutionResult =
  | { outcome: 'complete'; result: GatewayProviderActionResultMetadata }
  | { outcome: 'retry'; errorCode: string; retryAfterMs: number }
  | { outcome: 'dead_letter'; errorCode: string }
  | { outcome: 'owner_lost' }
  | { outcome: 'claim_lost' }
  | { outcome: 'already_transitioned' };

export interface GatewayProviderActionDiagnostic {
  backlog: number;
  oldestDueAgeMs?: number;
  deadLetterCount?: number;
  partialDeliveryCount?: number;
  nonceRecoveryIncompleteCount?: number;
  historyIncompleteCount?: number;
  formatterMismatchCount?: number;
  lastErrorCode?: string;
  updatedAt: string;
}

interface ProcessorState {
  owner: GatewayProviderActionOwner;
  stopped: boolean;
  wakeRequested: boolean;
  timer?: NodeJS.Timeout;
  inFlight?: Promise<void>;
}

interface GatewayProviderActionProcessorOptions {
  pollIntervalMs?: number;
  actionLeaseMs?: number;
  maxPerPass?: number;
  maxAttempts?: number;
  shutdownTimeoutMs?: number;
  onOwnerLost?: (owner: GatewayProviderActionOwner) => void;
  onPassComplete?: (owner: GatewayProviderActionOwner) => Promise<void> | void;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_ACTION_LEASE_MS = 2 * 60_000;
const DEFAULT_MAX_PER_PASS = 10;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
export const GATEWAY_PROVIDER_ACTION_BACKLOG_ALERT_COUNT = 100;
export const GATEWAY_PROVIDER_ACTION_OLDEST_DUE_ALERT_MS = 60_000;

/**
 * Serial, owner-scoped durable provider-action drainer.
 *
 * It owns no provider client. The execution callback must resolve the exact
 * process-local listener connector and perform the final database admission
 * immediately before its provider call.
 */
export class GatewayProviderActionProcessor {
  private readonly states = new Map<string, ProcessorState>();
  private readonly diagnostics = new Map<string, GatewayProviderActionDiagnostic>();
  private readonly pollIntervalMs: number;
  private readonly actionLeaseMs: number;
  private readonly maxPerPass: number;
  private readonly maxAttempts: number;
  private readonly shutdownTimeoutMs: number;
  private readonly onOwnerLost: (owner: GatewayProviderActionOwner) => void;
  private readonly onPassComplete: (owner: GatewayProviderActionOwner) => Promise<void> | void;

  constructor(
    private readonly repository: GatewayProviderActionRepository,
    private readonly identity: DistributedWorkIdentity,
    private readonly runWithTenant: <T>(tenantId: TenantID | string, work: () => T) => T,
    private readonly execute: (
      owner: GatewayProviderActionOwner,
      action: GatewayProviderAction,
      actionClaimToken: string
    ) => Promise<GatewayProviderActionExecutionResult>,
    options: GatewayProviderActionProcessorOptions = {}
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.actionLeaseMs = options.actionLeaseMs ?? DEFAULT_ACTION_LEASE_MS;
    this.maxPerPass = options.maxPerPass ?? DEFAULT_MAX_PER_PASS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.onOwnerLost = options.onOwnerLost ?? (() => undefined);
    this.onPassComplete = options.onPassComplete ?? (() => undefined);
  }

  private key(tenantId: TenantID | string, channelId: GatewayChannelID): string {
    return `${tenantId}\0${channelId}`;
  }

  start(owner: GatewayProviderActionOwner): void {
    const key = this.key(owner.tenantId, owner.channelId);
    const current = this.states.get(key);
    if (current && !current.stopped) {
      if (
        current.owner.listenerClaimToken === owner.listenerClaimToken &&
        current.owner.listenerGeneration === owner.listenerGeneration
      ) {
        current.owner = owner;
        this.wake(owner.tenantId, owner.channelId);
        return;
      }
      throw new Error('Provider action processor already has a different listener owner');
    }
    const state: ProcessorState = {
      owner,
      stopped: false,
      wakeRequested: false,
    };
    this.states.set(key, state);
    this.schedule(key, state, 0);
  }

  updateOwner(owner: GatewayProviderActionOwner): void {
    const state = this.states.get(this.key(owner.tenantId, owner.channelId));
    if (
      !state ||
      state.stopped ||
      state.owner.listenerClaimToken !== owner.listenerClaimToken ||
      state.owner.listenerGeneration !== owner.listenerGeneration
    ) {
      return;
    }
    state.owner = owner;
  }

  wake(tenantId: TenantID | string, channelId: GatewayChannelID): void {
    const key = this.key(tenantId, channelId);
    const state = this.states.get(key);
    if (!state || state.stopped) return;
    if (state.inFlight) {
      state.wakeRequested = true;
      return;
    }
    this.schedule(key, state, 0);
  }

  getDiagnostic(
    tenantId: TenantID | string,
    channelId: GatewayChannelID
  ): GatewayProviderActionDiagnostic | undefined {
    const value = this.diagnostics.get(this.key(tenantId, channelId));
    return value ? { ...value } : undefined;
  }

  private schedule(key: string, state: ProcessorState, delayMs: number): void {
    if (state.stopped || this.states.get(key) !== state) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      this.beginPass(key, state);
    }, delayMs);
    state.timer.unref?.();
  }

  private beginPass(key: string, state: ProcessorState): void {
    if (state.stopped || state.inFlight || this.states.get(key) !== state) return;
    const work = this.drainPass(key, state).catch(() => {
      this.diagnostics.set(key, {
        backlog: -1,
        lastErrorCode: 'processor_unavailable',
        updatedAt: new Date().toISOString(),
      });
    });
    state.inFlight = work;
    void work.finally(() => {
      if (state.inFlight === work) state.inFlight = undefined;
      if (state.stopped || this.states.get(key) !== state) return;
      const delay = state.wakeRequested ? 0 : this.pollIntervalMs;
      state.wakeRequested = false;
      this.schedule(key, state, delay);
    });
  }

  private async drainPass(key: string, state: ProcessorState): Promise<void> {
    let lastErrorCode: string | undefined;
    let processedAny = false;
    for (let index = 0; index < this.maxPerPass && !state.stopped; index += 1) {
      const actionClaimToken = generateId();
      const claimed = await this.runWithTenant(state.owner.tenantId, () =>
        this.repository.claimForListener({
          channelId: state.owner.channelId,
          listenerClaimToken: state.owner.listenerClaimToken,
          listenerGeneration: state.owner.listenerGeneration,
          actionClaimToken,
          leaseMs: this.actionLeaseMs,
          limit: 1,
          identity: this.identity,
        })
      );
      const action = claimed[0];
      if (!action) break;
      processedAny = true;

      let result: GatewayProviderActionExecutionResult;
      try {
        result = await this.runWithTenant(state.owner.tenantId, () =>
          this.execute(state.owner, action, actionClaimToken)
        );
      } catch {
        result = { outcome: 'retry', errorCode: 'processor_failure', retryAfterMs: 5_000 };
      }

      if (result.outcome === 'owner_lost') {
        lastErrorCode = 'listener_owner_lost';
        console.warn(
          `[gateway.provider_action] event=owner_lost channel_id=${JSON.stringify(state.owner.channelId)} code=listener_owner_lost`
        );
        state.stopped = true;
        this.onOwnerLost(state.owner);
        break;
      }
      if (result.outcome === 'claim_lost') {
        lastErrorCode = 'action_claim_lost';
        break;
      }
      if (result.outcome === 'already_transitioned') {
        continue;
      }

      const exactClaim = {
        actionId: action.id,
        channelId: state.owner.channelId,
        actionClaimToken,
        actionClaimGeneration: action.claim_generation,
        listenerClaimToken: state.owner.listenerClaimToken,
        listenerGeneration: state.owner.listenerGeneration,
      };
      let transitioned = false;
      if (result.outcome === 'complete') {
        transitioned = await this.runWithTenant(state.owner.tenantId, () =>
          this.repository.complete({
            ...exactClaim,
            result: result.result,
          })
        );
        if (!transitioned) {
          const refreshed = await this.runWithTenant(state.owner.tenantId, () =>
            this.repository.findById(action.id)
          );
          if (
            refreshed?.status === 'canceled' &&
            refreshed.last_error_code === 'discord_history_expired'
          ) {
            continue;
          }
          lastErrorCode = 'uncertain_completion';
          console.warn(
            `[gateway.provider_action] event=uncertain_completion action_id=${JSON.stringify(action.id)} channel_id=${JSON.stringify(state.owner.channelId)} code=stale_completion_fence`
          );
          break;
        }
      } else if (result.outcome === 'retry' && action.attempts < this.maxAttempts) {
        transitioned = await this.runWithTenant(state.owner.tenantId, () =>
          this.repository.retry({
            ...exactClaim,
            errorCode: result.errorCode,
            retryAfterMs: result.retryAfterMs,
          })
        );
        lastErrorCode = result.errorCode;
      } else {
        const errorCode = result.outcome === 'retry' ? 'attempts_exhausted' : result.errorCode;
        transitioned = await this.runWithTenant(state.owner.tenantId, () =>
          this.repository.deadLetter({ ...exactClaim, errorCode })
        );
        lastErrorCode = errorCode;
        if (transitioned) {
          console.warn(
            `[gateway.provider_action] event=dead_letter action_id=${JSON.stringify(action.id)} channel_id=${JSON.stringify(state.owner.channelId)} code=${JSON.stringify(errorCode)}`
          );
        }
      }
      if (!transitioned) break;
    }

    const durable = await this.runWithTenant(state.owner.tenantId, () =>
      this.repository.getBacklogMetrics(state.owner.channelId)
    ).catch(() => undefined);
    if (
      durable &&
      (durable.activeCount >= GATEWAY_PROVIDER_ACTION_BACKLOG_ALERT_COUNT ||
        durable.oldestDueAgeMs >= GATEWAY_PROVIDER_ACTION_OLDEST_DUE_ALERT_MS ||
        durable.deadLetterCount > 0 ||
        durable.partialDeliveryCount > 0 ||
        durable.nonceRecoveryIncompleteCount > 0 ||
        durable.historyIncompleteCount > 0 ||
        durable.formatterMismatchCount > 0)
    ) {
      console.warn(
        `[gateway.provider_action] event=backlog_degraded channel_id=${JSON.stringify(state.owner.channelId)} active_count=${durable.activeCount} oldest_due_age_ms=${durable.oldestDueAgeMs} dead_letter_count=${durable.deadLetterCount} partial_delivery_count=${durable.partialDeliveryCount} nonce_recovery_incomplete_count=${durable.nonceRecoveryIncompleteCount} history_incomplete_count=${durable.historyIncompleteCount} formatter_mismatch_count=${durable.formatterMismatchCount}`
      );
    }
    this.diagnostics.set(key, {
      backlog: durable?.activeCount ?? -1,
      ...(durable
        ? {
            oldestDueAgeMs: durable.oldestDueAgeMs,
            deadLetterCount: durable.deadLetterCount,
            partialDeliveryCount: durable.partialDeliveryCount,
            nonceRecoveryIncompleteCount: durable.nonceRecoveryIncompleteCount,
            historyIncompleteCount: durable.historyIncompleteCount,
            formatterMismatchCount: durable.formatterMismatchCount,
          }
        : {}),
      ...(lastErrorCode ? { lastErrorCode } : {}),
      updatedAt: new Date().toISOString(),
    });
    if (processedAny && !state.stopped && this.states.get(key) === state) {
      try {
        await this.onPassComplete(state.owner);
      } catch {
        // Presence/diagnostic refresh is non-critical provider UX and must not
        // alter a durable provider action transition.
      }
    }
  }

  async stop(tenantId: TenantID | string, channelId: GatewayChannelID): Promise<boolean> {
    const key = this.key(tenantId, channelId);
    const state = this.states.get(key);
    if (!state) return true;
    state.stopped = true;
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    const inFlight = state.inFlight;
    if (!inFlight) {
      if (this.states.get(key) === state) this.states.delete(key);
      return true;
    }
    let timer: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      inFlight.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), this.shutdownTimeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (drained && this.states.get(key) === state) this.states.delete(key);
    if (!drained) {
      void inFlight.finally(() => {
        if (this.states.get(key) === state) this.states.delete(key);
      });
    }
    return drained;
  }
}
