import { getCurrentTenantDatabaseScope, runWithoutTenantDatabaseScope } from '@agor/core/db';
import { NotAuthenticated } from '@agor/core/feathers';
import type { UserID } from '@agor/core/types';
import { LaunchMembershipRefusedError, type LaunchSessionRevalidator } from './launch-auth.js';
import { runtimeTenantClaims } from './runtime-tokens.js';
import { AUTH_LAUNCH_SUBJECT_CLAIM, AUTH_REVALIDATED_AT_MS_CLAIM } from './session-lifetime.js';

/** How long a confirmed membership lets personal API keys skip the issuer; matches the access-token lifetime. */
export const API_KEY_MEMBERSHIP_CHECK_INTERVAL_MS = 15 * 60 * 1000;
/** How long a check the issuer couldn't answer waits, so a request burst can't hammer a struggling issuer. */
export const API_KEY_MEMBERSHIP_RETRY_MS = 60 * 1000;
/** Evicting a user only costs one extra issuer call and any outage grace on this replica. */
export const API_KEY_MEMBERSHIP_MAX_TRACKED_USERS = 10_000;

export type ApiKeyMembershipOutcome = 'allowed' | 'rejected' | 'unavailable';

export type ApiKeyMembershipCheck = (input: {
  tenantId: string | undefined;
  userId: UserID;
}) => Promise<ApiKeyMembershipOutcome>;

interface TrackedMembership {
  outcome: ApiKeyMembershipOutcome;
  nextCheckAtMs: number;
  confirmedAtMs?: number;
  launchSubject?: string;
  refused?: boolean;
}

/**
 * Rate-limits the issuer membership check for direct personal API key use.
 * This state is a per-replica throttle: a refusal deletes the user's keys durably,
 * so for keys a confirmation remembered here can't outlive it on another replica.
 * MCP session tokens have no such fence and rely on each replica's own check.
 */
export function createApiKeyMembershipCheck(options: {
  revalidate: LaunchSessionRevalidator;
  tenantClaim?: string;
  now?: () => number;
}): ApiKeyMembershipCheck {
  const now = options.now ?? Date.now;
  const tracked = new Map<string, TrackedMembership>();
  const inFlight = new Map<string, Promise<ApiKeyMembershipOutcome>>();

  const remember = (key: string, membership: TrackedMembership): ApiKeyMembershipOutcome => {
    // Re-inserting keeps the Map ordered by last check, so eviction takes the stalest user.
    tracked.delete(key);
    tracked.set(key, membership);
    if (tracked.size > API_KEY_MEMBERSHIP_MAX_TRACKED_USERS) {
      tracked.delete(tracked.keys().next().value as string);
    }
    return membership.outcome;
  };

  const check = async (
    key: string,
    tenantId: string | undefined,
    userId: UserID
  ): Promise<ApiKeyMembershipOutcome> => {
    const previous = tracked.get(key);
    const { confirmedAtMs, launchSubject } = previous ?? {};
    try {
      const result = await options.revalidate({
        userId,
        payload: {
          sub: userId,
          ...runtimeTenantClaims(tenantId, options.tenantClaim),
          ...(confirmedAtMs ? { [AUTH_REVALIDATED_AT_MS_CLAIM]: confirmedAtMs } : {}),
          // A known subject skips the identity lookup, so a brief database error stays within the outage grace.
          ...(launchSubject ? { [AUTH_LAUNCH_SUBJECT_CLAIM]: launchSubject } : {}),
        },
      });
      const nowMs = now();
      if (result?.notAfterSeconds !== undefined) {
        return remember(key, {
          outcome: 'allowed',
          nextCheckAtMs: Math.min(
            nowMs + API_KEY_MEMBERSHIP_RETRY_MS,
            result.notAfterSeconds * 1000
          ),
          confirmedAtMs: result.revalidatedAtMs,
          launchSubject: result.launchSubject,
        });
      }
      return remember(key, {
        outcome: 'allowed',
        nextCheckAtMs: nowMs + API_KEY_MEMBERSHIP_CHECK_INTERVAL_MS,
        confirmedAtMs: result?.revalidatedAtMs,
        launchSubject: result?.launchSubject,
      });
    } catch (error) {
      if (error instanceof LaunchMembershipRefusedError) {
        // A refusal repeats its side effects, so it waits as long as a confirmation does.
        return remember(key, {
          outcome: 'rejected',
          nextCheckAtMs: now() + API_KEY_MEMBERSHIP_CHECK_INTERVAL_MS,
          refused: true,
        });
      }
      return remember(key, {
        // Neither an outage nor a bad response can overturn a refusal; only a confirmation can.
        outcome:
          error instanceof NotAuthenticated || previous?.refused ? 'rejected' : 'unavailable',
        nextCheckAtMs: now() + API_KEY_MEMBERSHIP_RETRY_MS,
        confirmedAtMs: previous?.confirmedAtMs,
        launchSubject: previous?.launchSubject,
        refused: previous?.refused,
      });
    }
  };

  return async ({ tenantId, userId }) => {
    const key = `${tenantId ?? ''}\0${userId}`;
    const membership = tracked.get(key);
    if (membership && now() < membership.nextCheckAtMs) return membership.outcome;
    let pending = inFlight.get(key);
    if (!pending) {
      // Keep the issuer call and any refusal out of the request's transaction, so a rejected request can't undo the refusal.
      pending = runWithoutTenantDatabaseScope(() => check(key, tenantId, userId)).finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, pending);
    }
    // A request transaction pins a pool connection the check also needs, so waiting here could starve the pool.
    const scope = getCurrentTenantDatabaseScope();
    if (scope?.kind === 'tenant' && scope.transactionActive) {
      return membership?.outcome ?? 'allowed';
    }
    return pending;
  };
}
