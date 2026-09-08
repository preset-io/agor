/** PostgreSQL/HA Codex device auth with DB-clock poll leases and generation fencing. */

import { isTenantAgenticToolEnabled } from '@agor/core/config';
import {
  type CodexDeviceAuthAttemptRecord,
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import { BadRequest, NotAuthenticated } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  CodexDeviceAuthStatus,
  TenantID,
  UserID,
} from '@agor/core/types';
import type { CodexCredentialBindInvalidator } from '../codex-auth-bind-invalidation.js';
import {
  type AppLike,
  persistVerifiedCodexAuth,
  resolveCodexCredentialRoute,
  sameCodexCredentialRoute,
} from './codex-auth-shared.js';
import type { CodexDeviceAuthAttemptAuthority } from './codex-device-auth-attempt-authority.js';
import {
  exchangeCodexDeviceAuthorization,
  pollCodexDeviceAuthorization,
} from './codex-device-auth-flow.js';
import {
  buildDeviceAuthJson,
  CODEX_AUTH_ISSUER,
  type CodexDeviceAuthProvider,
  codexDeviceAuthProvider,
  DeviceAuthProviderError,
} from './codex-device-auth-provider.js';

const POLL_LEASE_MS = 25_000;
const MAINTENANCE_INTERVAL_MS = 60_000;
const UNAVAILABLE_HINT =
  'Your ChatGPT account does not allow device-code sign-in. Personal accounts can turn it on under ChatGPT Settings → Security → "Device code authorization for Codex"; workspace accounts need an admin to enable it. You can also paste an auth.json or use an API key instead.';

interface PollContext {
  authUser: NonNullable<AuthenticatedParams['user']>;
  tenantId: TenantID | string;
  userId: UserID;
}

interface Worker {
  context: PollContext;
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
}

function safeHint(record: CodexDeviceAuthAttemptRecord): string | undefined {
  switch (record.status) {
    case 'succeeded':
      return record.planType
        ? `Signed in with ChatGPT (${record.planType} plan).`
        : 'Signed in with ChatGPT.';
    case 'unavailable':
      return UNAVAILABLE_HINT;
    case 'expired':
      return 'The sign-in code expired — get a new one and try again.';
    case 'denied':
      return 'ChatGPT sign-in was denied — get a new code if you want to try again.';
    case 'ambiguous':
      return 'The sign-in result could not be confirmed safely — check your login status or start again.';
    case 'cancelled':
      return 'ChatGPT sign-in was cancelled.';
    case 'superseded':
      return 'A newer ChatGPT sign-in replaced this attempt.';
    case 'failed':
      return 'ChatGPT sign-in failed — get a new code and try again.';
    default:
      return undefined;
  }
}

function phase(record: CodexDeviceAuthAttemptRecord): CodexDeviceAuthStatus['phase'] {
  switch (record.status) {
    case 'starting':
    case 'pending':
    case 'exchanging':
    case 'persisting':
      return 'pending';
    case 'succeeded':
      return 'success';
    case 'unavailable':
      return 'unavailable';
    case 'expired':
      return 'expired';
    default:
      return 'error';
  }
}

export function createDurableCodexDeviceAuthService(
  app: AppLike,
  db: TenantScopeAwareDatabase,
  authority: CodexDeviceAuthAttemptAuthority,
  provider: CodexDeviceAuthProvider = codexDeviceAuthProvider,
  invalidateCredentialBinds: CodexCredentialBindInvalidator = async () => undefined
) {
  const workers = new Map<string, Worker>();

  const maintenance = setInterval(() => {
    void authority.maintain().catch((error) => {
      console.error(
        `[CodexDeviceAuth] Attempt maintenance failed: ${error instanceof Error ? error.constructor.name : 'unknown error'}`
      );
    });
  }, MAINTENANCE_INTERVAL_MS);
  maintenance.unref?.();

  async function requireContext(params?: AuthenticatedParams): Promise<PollContext> {
    const authUser = params?.user;
    if (!authUser?.user_id) {
      throw new NotAuthenticated('Sign in before starting a ChatGPT device sign-in.');
    }
    const tenantId = getCurrentTenantId();
    if (!tenantId) throw new Error('Missing active tenant context for Codex device auth');
    return { authUser, tenantId, userId: authUser.user_id as UserID };
  }

  function clearWorker(attemptId: string): void {
    const worker = workers.get(attemptId);
    if (worker?.timer) clearTimeout(worker.timer);
    workers.delete(attemptId);
  }

  function schedule(record: CodexDeviceAuthAttemptRecord, context: PollContext): void {
    if (record.status !== 'pending' || !record.isCurrent) {
      clearWorker(record.attemptId);
      return;
    }
    let worker = workers.get(record.attemptId);
    if (!worker) {
      worker = { context, running: false };
      workers.set(record.attemptId, worker);
    } else {
      worker.context = context;
    }
    if (worker.running || worker.timer) return;
    const wakeAt = record.pollLeaseExpiresAt ?? record.pollNextAt ?? new Date();
    const delay = Math.max(0, Math.min(wakeAt.getTime() - Date.now(), 30_000));
    worker.timer = setTimeout(() => {
      worker!.timer = undefined;
      void pollOnce(record.attemptId, worker!);
    }, delay);
    worker.timer.unref?.();
  }

  async function rescheduleCurrent(worker: Worker, attemptId: string): Promise<void> {
    const current = await authority.getCurrentForUser(
      worker.context.tenantId,
      worker.context.userId
    );
    if (!current || current.attemptId !== attemptId || current.status !== 'pending') {
      clearWorker(attemptId);
      return;
    }
    schedule(current, worker.context);
  }

  async function pollOnce(attemptId: string, worker: Worker): Promise<void> {
    if (worker.running) return;
    worker.running = true;
    try {
      const current = await authority.getCurrentForUser(
        worker.context.tenantId,
        worker.context.userId
      );
      if (!current || current.attemptId !== attemptId || current.status !== 'pending') {
        clearWorker(attemptId);
        return;
      }
      const claimed = await authority.claimPoll(current, POLL_LEASE_MS);
      if (!claimed) return;
      let material: ReturnType<CodexDeviceAuthAttemptAuthority['open']>;
      try {
        material = authority.open(claimed);
      } catch {
        await authority.finishPoll(claimed, 'failed', 'attempt_material_unavailable');
        return;
      }
      if (!material.deviceAuthId || !material.userCode) {
        await authority.finishPoll(claimed, 'failed', 'attempt_material_incomplete');
        return;
      }

      const polled = await pollCodexDeviceAuthorization(provider, {
        deviceAuthId: material.deviceAuthId,
        userCode: material.userCode,
        intervalMs: claimed.pollIntervalMs ?? 5_000,
      });

      if (polled.outcome === 'retry') {
        await authority.recordPending(claimed, polled.intervalMs);
        return;
      }
      if (polled.outcome === 'failed') {
        await authority.finishPoll(claimed, 'failed', 'provider_poll_rejected');
        return;
      }
      if (polled.outcome === 'denied') {
        await authority.finishPoll(claimed, 'denied', 'authorization_denied');
        return;
      }
      if (polled.outcome === 'expired') {
        await authority.finishPoll(claimed, 'expired', 'authorization_timed_out');
        return;
      }

      const exchange = await authority.claimExchange(claimed);
      if (!exchange) return;
      const exchanged = await exchangeCodexDeviceAuthorization(provider, polled.approved);
      if (exchanged.outcome === 'failed') {
        await authority.failExchange(
          exchange,
          exchanged.certainty === 'ambiguous' ? 'ambiguous' : 'failed',
          exchanged.certainty === 'ambiguous'
            ? 'token_exchange_ambiguous'
            : 'token_exchange_rejected'
        );
        return;
      }
      const { tokens } = exchanged;

      try {
        const finalized = await authority.finalize(exchange, async (route) => {
          const currentRoute = await resolveCodexCredentialRoute(
            worker.context.userId,
            <T>(work: (tenantDb: TenantScopedDatabase) => Promise<T>) =>
              runWithTenantDatabaseScope(db, worker.context.tenantId, work),
            app.get('config')
          );
          if (!currentRoute.ok || !sameCodexCredentialRoute(currentRoute, route)) {
            throw new BadRequest(
              'The execution home changed while you were signing in. Start over to save the login in the right home.'
            );
          }
          const summary = await persistVerifiedCodexAuth({
            app,
            normalized: buildDeviceAuthJson(tokens),
            delegatedHomeKey: route.delegatedHomeKey,
            userId: worker.context.userId,
            authUser: worker.context.authUser,
            codexHome: route.codexHome,
            authorityGeneration: route.attemptGeneration,
          });
          return { value: summary, planType: summary.planType };
        });
        if (finalized.outcome === 'committed') {
          await invalidateCredentialBinds({
            tenantId: String(worker.context.tenantId),
            userId: worker.context.userId,
            reason: 'credentials_imported',
          });
        }
      } catch (error) {
        console.error(
          `[CodexDeviceAuth] Credential finalization failed: ${error instanceof Error ? error.constructor.name : 'unknown error'}`
        );
      }
    } catch (error) {
      console.error(
        `[CodexDeviceAuth] Poll worker failed: ${error instanceof Error ? error.constructor.name : 'unknown error'}`
      );
    } finally {
      worker.running = false;
      if (workers.get(attemptId) === worker) {
        await rescheduleCurrent(worker, attemptId).catch(() => clearWorker(attemptId));
      }
    }
  }

  async function publicStatus(
    record: CodexDeviceAuthAttemptRecord | null
  ): Promise<CodexDeviceAuthStatus> {
    if (!record) return { phase: 'idle' };
    const result: CodexDeviceAuthStatus = {
      phase: phase(record),
      attemptId: record.attemptId,
    };
    if (['pending', 'exchanging', 'persisting'].includes(record.status)) {
      try {
        const material = authority.open(record);
        if (material.userCode) {
          result.userCode = material.userCode;
          result.verificationUrl = `${CODEX_AUTH_ISSUER}/codex/device`;
          result.expiresAt = record.expiresAt.toISOString();
        }
      } catch {
        // A malformed sealed row is not exposed; the worker will terminalize it.
      }
    }
    if (record.planType) result.planType = record.planType;
    const hint = safeHint(record);
    if (hint) result.hint = hint;
    return result;
  }

  return {
    async create(_data: unknown, params?: AuthenticatedParams): Promise<CodexDeviceAuthStatus> {
      const context = await requireContext(params);
      const withTenantDatabase = <T>(work: (tenantDb: TenantScopedDatabase) => Promise<T>) =>
        runWithTenantDatabaseScope(db, context.tenantId, work);
      if (
        !(await withTenantDatabase((tenantDb) => isTenantAgenticToolEnabled('codex', tenantDb)))
      ) {
        throw new BadRequest('Codex is disabled for this workspace.');
      }
      const route = await resolveCodexCredentialRoute(
        context.userId,
        withTenantDatabase,
        app.get('config')
      );
      if (!route.ok) {
        throw new BadRequest(
          `Cannot determine which execution home should hold this Codex login: ${route.message}`
        );
      }

      const reserved = await authority.reserve({
        tenantId: String(context.tenantId),
        userId: context.userId,
        delegatedHomeKey: route.delegatedHomeKey,
        codexHome: route.codexHome,
        validateRoute: async () => {
          const currentRoute = await resolveCodexCredentialRoute(
            context.userId,
            withTenantDatabase,
            app.get('config')
          );
          if (!currentRoute.ok || !sameCodexCredentialRoute(currentRoute, route)) {
            throw new BadRequest(
              'The execution home changed before sign-in started. Start again to use the current home.'
            );
          }
          return true;
        },
      });
      let grant: Awaited<ReturnType<CodexDeviceAuthProvider['requestUserCode']>>;
      try {
        grant = await provider.requestUserCode();
      } catch (error) {
        await authority.markStartingTerminal(reserved.record, 'failed', 'usercode_request_failed');
        const terminal =
          error instanceof DeviceAuthProviderError && error.disposition === 'terminal';
        throw new BadRequest(
          terminal
            ? 'ChatGPT rejected the sign-in request — try again later, or paste an auth.json / use an API key instead.'
            : 'Could not reach ChatGPT to start the sign-in — check the server’s network access and try again.'
        );
      }
      if (grant === 'unavailable') {
        await authority.markStartingTerminal(
          reserved.record,
          'unavailable',
          'device_auth_unavailable'
        );
      } else {
        const attached = await authority.attachGrant(reserved, grant);
        if (attached) schedule(attached, context);
      }
      const current = await authority.getCurrentForUser(context.tenantId, context.userId);
      if (current?.status === 'pending') schedule(current, context);
      return publicStatus(current);
    },

    async find(params?: AuthenticatedParams): Promise<CodexDeviceAuthStatus> {
      const context = await requireContext(params);
      const current = await authority.getCurrentForUser(context.tenantId, context.userId);
      if (current?.status === 'pending') schedule(current, context);
      return publicStatus(current);
    },

    async remove(id: unknown, params?: AuthenticatedParams): Promise<CodexDeviceAuthStatus> {
      const context = await requireContext(params);
      if (typeof id !== 'string' || !id) {
        throw new BadRequest('The Codex device sign-in attempt id is required.');
      }
      const removed = await authority.cancel(
        String(context.tenantId),
        context.userId,
        id as CodexDeviceAuthAttemptRecord['attemptId']
      );
      for (const [attemptId, worker] of workers) {
        if (
          worker.context.tenantId === context.tenantId &&
          worker.context.userId === context.userId &&
          attemptId === id
        ) {
          clearWorker(attemptId);
        }
      }
      if (removed === 0) {
        const current = await authority.getCurrentForUser(context.tenantId, context.userId);
        if (current?.status === 'pending') schedule(current, context);
        return publicStatus(current);
      }
      return { phase: 'idle' };
    },
  };
}
