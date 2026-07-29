/**
 * Method-agnostic 401 retry with single-flight re-authentication for the
 * executor's Feathers socket client.
 *
 * Modeled on the reviewed UI pattern in `apps/agor-ui/src/hooks/useAgorClient.ts`
 * (PR #1058), adapted for the executor:
 *
 *   - The UI refreshes an access token (rotating refresh tokens), so its
 *     single-flight guards against rotating the refresh token N times. The
 *     executor holds a long-lived (~24h) session JWT and simply re-presents it
 *     via `reAuthenticate()` / `authenticate()`, so here the single-flight
 *     coalesces concurrent socket re-auths into one and — critically — makes
 *     every caller await the SAME real result rather than an optimistic early
 *     `true`.
 *
 *   - There is NO proactive refresh timer. Re-presenting a JWT cannot extend
 *     its baked-in expiry, so a timer would be useless. Recovery is reactive:
 *     a call fails with 401 → single-flight reauth → retry the original call
 *     once.
 *
 * The retry can only succeed while a still-valid credential exists to
 * re-authenticate with. If the underlying session JWT has itself expired,
 * reauth also fails, `reauthenticate` resolves `false`, and the call fails
 * cleanly after one attempt — no loop. Refreshable machine tokens are out of
 * scope.
 */

import type { AgorClient } from '@agor/core/api';
import { isDefiniteAuthFailure } from './auth-errors';

/**
 * Wrap an async function so concurrent invocations share a single in-flight
 * promise. The first caller runs `fn`; callers that arrive while it is pending
 * receive the same promise (and therefore the same resolved/rejected result).
 * Once it settles, the slot clears so a later call starts fresh.
 *
 * Coalescing is by wall-clock overlap only — the winner's arguments are used
 * for the shared run; concurrent callers' arguments are ignored (they differ
 * only in a logging label here).
 */
export function createSingleFlight<A extends unknown[], T>(
  fn: (...args: A) => Promise<T>
): (...args: A) => Promise<T> {
  let inflight: Promise<T> | null = null;
  return (...args: A): Promise<T> => {
    if (inflight) return inflight;
    const run = fn(...args).finally(() => {
      if (inflight === run) inflight = null;
    });
    inflight = run;
    return inflight;
  };
}

/**
 * Feathers v5 hooks pass a mutable context object and a `next` continuation to
 * `around` hooks. We type the subset we touch loosely to avoid pulling
 * `@feathersjs/feathers` into the executor's dependency graph.
 */
export interface AroundHookContext {
  path?: string;
  method?: string;
  params?: Record<string, unknown>;
  arguments?: unknown[];
  result?: unknown;
}

export type AroundHookNext = () => Promise<void>;

/** Default flag key stamped on retried calls to break the retry loop. */
export const DEFAULT_RETRY_FLAG = '_reauthRetried';

/**
 * Service paths whose calls must NOT be wrapped by the retry. The reauth
 * routine itself calls the `authentication` service; retrying those on 401
 * would recurse/deadlock. Mirrors the UI's exact-match skip set so
 * auth-adjacent routes (e.g. `authentication/impersonate`) still flow through
 * the retry like any other service call.
 */
export const DEFAULT_AUTH_PATHS_TO_SKIP = new Set(['authentication', 'authentication/refresh']);

export interface AuthRetryHookOptions {
  /**
   * Re-authenticate the socket. Must be single-flight (see
   * {@link createSingleFlight}) so concurrent 401s trigger exactly one reauth.
   * Resolves `true` when the socket is authenticated again, `false` when reauth
   * failed (e.g. the underlying credential is itself expired) — in which case
   * the original call is surfaced without retry.
   */
  reauthenticate: (label: string) => Promise<boolean>;
  /** The client used to re-invoke the original service method on retry. */
  client: AgorClient;
  authPathsToSkip?: Set<string>;
  retryFlag?: string;
}

/**
 * Build a method-agnostic `around.all` hook that, on a definite auth failure,
 * runs single-flight reauth and retries the ORIGINAL call exactly once.
 *
 * Method-agnostic: instead of switching over find/get/create/patch/…, it
 * replays the call generically via `context.arguments` +
 * `service[context.method](...args)`, so custom (non-CRUD) service methods
 * retry too. A `retryFlag` stamped on the trailing params object stops the
 * retry from looping if it also 401s.
 */
export function createAuthRetryAroundHook(
  options: AuthRetryHookOptions
): (context: AroundHookContext, next: AroundHookNext) => Promise<void> {
  const skip = options.authPathsToSkip ?? DEFAULT_AUTH_PATHS_TO_SKIP;
  const retryFlag = options.retryFlag ?? DEFAULT_RETRY_FLAG;
  const { client, reauthenticate } = options;

  return async (context: AroundHookContext, next: AroundHookNext): Promise<void> => {
    const path = context.path;

    // Never wrap the reauth call itself — it would recurse/deadlock.
    if (typeof path === 'string' && skip.has(path)) {
      await next();
      return;
    }

    try {
      await next();
    } catch (err) {
      // Only recover from definite auth failures. Transient connection/5xx
      // errors are left to the socket transport's own reconnect — treating
      // them as auth failures would burn the one-shot retry pointlessly.
      if (!isDefiniteAuthFailure(err)) throw err;

      // One-shot guard: if this call is already a retry, don't retry again.
      const currentParams = (context.params ?? {}) as Record<string, unknown>;
      if (currentParams[retryFlag]) throw err;

      if (typeof path !== 'string') throw err;

      // Single-flight reauth: many concurrent 401s coalesce into one.
      const reauthed = await reauthenticate('401 retry');
      if (!reauthed) throw err;

      // Replay the original call via its raw argument list so custom
      // (non-CRUD) service methods retry correctly too. Feathers service
      // methods always end with a `params` arg; stamp the retry flag there to
      // stop recursion if the retry itself 401s.
      const args = context.arguments ? [...context.arguments] : [];
      const lastIdx = args.length - 1;
      const lastArg = args[lastIdx];
      const isParamsObject =
        lastArg !== null && typeof lastArg === 'object' && !Array.isArray(lastArg);
      const retryParams = {
        ...(isParamsObject ? (lastArg as Record<string, unknown>) : {}),
        [retryFlag]: true,
      };
      if (isParamsObject) {
        args[lastIdx] = retryParams;
      } else {
        args.push(retryParams);
      }

      const service = client.service(path) as unknown as Record<string, unknown>;
      const method = context.method as string;
      const methodFn = service[method];
      if (typeof methodFn !== 'function') throw err;
      context.result = await (methodFn as (...a: unknown[]) => unknown).call(service, ...args);
    }
  };
}
