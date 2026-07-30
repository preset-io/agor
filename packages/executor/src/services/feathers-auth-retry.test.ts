import type { AgorClient } from '@agor/core/api';
import { describe, expect, it, vi } from 'vitest';
import {
  type AroundHookContext,
  createAuthRetryAroundHook,
  createSingleFlight,
} from './feathers-auth-retry';

/** A Feathers-shaped NotAuthenticated error (401). */
function make401(message = 'jwt expired'): Error {
  const err = new Error(message) as Error & { name: string; code: number; className: string };
  err.name = 'NotAuthenticated';
  err.code = 401;
  err.className = 'not-authenticated';
  return err;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A tiny Feathers-like dispatcher that runs the around hook for every service
 * call AND routes the hook's own retry re-invocation
 * (`client.service(path)[method](...)`) back through the same hook — mirroring
 * how a real Feathers app re-runs the hook chain on the retry. This is what
 * makes the one-shot guard testable end-to-end.
 */
function createHarness(opts: {
  /** Called for every raw service call; throw to simulate a server rejection. */
  server: (ctx: { path: string; method: string; args: unknown[]; callIndex: number }) => unknown;
  /** Result of a reauth attempt. */
  reauthResult?: boolean;
  /** Side effect run inside the (single-flight) reauth, e.g. flipping auth on. */
  onReauth?: () => void;
  /** Delay inside reauth so overlapping callers coalesce. */
  reauthDelayMs?: number;
}) {
  let serverCalls = 0;
  let reauthCalls = 0;

  const reauthenticate = createSingleFlight(async (_label: string): Promise<boolean> => {
    reauthCalls += 1;
    if (opts.reauthDelayMs) await delay(opts.reauthDelayMs);
    opts.onReauth?.();
    return opts.reauthResult ?? true;
  });

  // Forward-declared so client.service can reach it.
  let dispatch!: (path: string, method: string, ...args: unknown[]) => Promise<unknown>;

  const client = {
    service: (path: string) =>
      new Proxy(
        {},
        {
          get:
            (_target, method: string) =>
            (...args: unknown[]) =>
              dispatch(path, method, ...args),
        }
      ),
  } as unknown as AgorClient;

  const hook = createAuthRetryAroundHook({ client, reauthenticate });

  dispatch = async (path: string, method: string, ...args: unknown[]): Promise<unknown> => {
    const last = args[args.length - 1];
    const params =
      last && typeof last === 'object' && !Array.isArray(last)
        ? (last as Record<string, unknown>)
        : {};
    const context: AroundHookContext = { path, method, arguments: args, params };
    const next = async () => {
      const callIndex = serverCalls;
      serverCalls += 1;
      context.result = opts.server({ path, method, args, callIndex });
    };
    await hook(context, next);
    return context.result;
  };

  return {
    dispatch,
    reauthenticate,
    getServerCalls: () => serverCalls,
    getReauthCalls: () => reauthCalls,
  };
}

describe('createSingleFlight', () => {
  it('coalesces concurrent calls into one run, then allows a fresh run', async () => {
    let runs = 0;
    const sf = createSingleFlight(async () => {
      runs += 1;
      await delay(10);
      return runs;
    });

    const [a, b, c] = await Promise.all([sf(), sf(), sf()]);
    expect(runs).toBe(1);
    expect([a, b, c]).toEqual([1, 1, 1]);

    // After the in-flight settles, a new call starts fresh.
    const d = await sf();
    expect(runs).toBe(2);
    expect(d).toBe(2);
  });

  it('clears the in-flight slot even when the run rejects', async () => {
    let runs = 0;
    const sf = createSingleFlight(async () => {
      runs += 1;
      await delay(5);
      throw new Error(`boom ${runs}`);
    });

    await expect(Promise.all([sf(), sf()])).rejects.toThrow('boom 1');
    expect(runs).toBe(1);
    await expect(sf()).rejects.toThrow('boom 2');
    expect(runs).toBe(2);
  });
});

describe('createAuthRetryAroundHook', () => {
  it('concurrent-401: N simultaneous 401s trigger exactly ONE reauth and all retry once and succeed', async () => {
    let authed = false;
    const harness = createHarness({
      reauthDelayMs: 15,
      onReauth: () => {
        authed = true;
      },
      server: () => {
        if (!authed) throw make401();
        return { ok: true };
      },
    });

    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, (_v, i) => harness.dispatch('messages', 'find', { query: { i } }))
    );

    // Exactly one reauth despite N concurrent 401s (single-flight).
    expect(harness.getReauthCalls()).toBe(1);
    // Each request hit the server twice: original 401 + one successful retry.
    expect(harness.getServerCalls()).toBe(N * 2);
    for (const r of results) expect(r).toEqual({ ok: true });
  });

  it('reconnect-race: an overlapping reconnect reauth and a 401-driven reauth do not double-authenticate or deadlock', async () => {
    let authed = false;
    const harness = createHarness({
      reauthDelayMs: 20,
      onReauth: () => {
        authed = true;
      },
      server: () => {
        if (!authed) throw make401();
        return { ok: true };
      },
    });

    // Kick off a socket-reconnect reauth (as the reconnect handler would)...
    const reconnectReauth = harness.reauthenticate('reconnect');
    // ...while a live request fails with 401 and drives its own reauth.
    const request = harness.dispatch('sessions', 'get', 'session-1', {});

    const [reconnectOk, result] = await Promise.all([reconnectReauth, request]);

    expect(reconnectOk).toBe(true);
    expect(result).toEqual({ ok: true });
    // Both paths coalesced into a single reauth.
    expect(harness.getReauthCalls()).toBe(1);
    // Original 401 + one retry.
    expect(harness.getServerCalls()).toBe(2);
  });

  it('one-shot guard: a call that 401s, reauths, then 401s again fails after exactly one retry', async () => {
    // Server always rejects with 401 even after a "successful" reauth
    // (e.g. the underlying credential is genuinely dead but reauth reports ok).
    const harness = createHarness({
      reauthResult: true,
      server: () => {
        throw make401();
      },
    });

    await expect(harness.dispatch('messages', 'find', { query: {} })).rejects.toMatchObject({
      name: 'NotAuthenticated',
    });

    // Reauth ran once; the retry's own 401 is short-circuited by the guard.
    expect(harness.getReauthCalls()).toBe(1);
    // Exactly two server calls: original + one retry. No infinite loop.
    expect(harness.getServerCalls()).toBe(2);
  });

  it('fails cleanly without retry when reauth itself fails (dead session JWT)', async () => {
    const harness = createHarness({
      reauthResult: false, // reauth cannot recover — nothing valid to present
      server: () => {
        throw make401();
      },
    });

    await expect(harness.dispatch('messages', 'find', {})).rejects.toMatchObject({
      name: 'NotAuthenticated',
    });

    expect(harness.getReauthCalls()).toBe(1);
    // Only the original call — no retry attempted once reauth reports failure.
    expect(harness.getServerCalls()).toBe(1);
  });

  it('does not reauth or retry on transient (non-auth) errors', async () => {
    const transient = Object.assign(new Error('service unavailable'), { code: 503 });
    const harness = createHarness({
      server: () => {
        throw transient;
      },
    });

    await expect(harness.dispatch('messages', 'find', {})).rejects.toThrow('service unavailable');
    expect(harness.getReauthCalls()).toBe(0);
    expect(harness.getServerCalls()).toBe(1);
  });

  it('skips the authentication service so reauth cannot recurse', async () => {
    const reauthenticate = vi.fn(async () => true);
    const client = {
      service: () => ({}),
    } as unknown as AgorClient;
    const hook = createAuthRetryAroundHook({ client, reauthenticate });

    const context: AroundHookContext = {
      path: 'authentication',
      method: 'create',
      arguments: [{}],
      params: {},
    };
    const next = vi.fn(async () => {
      throw make401();
    });

    await expect(hook(context, next)).rejects.toMatchObject({ name: 'NotAuthenticated' });
    // The auth path is excluded, so no reauth is attempted on its 401.
    expect(reauthenticate).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('retries custom (non-CRUD) methods generically via context.arguments', async () => {
    let authed = false;
    const harness = createHarness({
      reauthDelayMs: 5,
      onReauth: () => {
        authed = true;
      },
      server: ({ method }) => {
        if (!authed) throw make401();
        return { method };
      },
    });

    // A custom method name that no CRUD switch would handle.
    const result = await harness.dispatch('sessions/session-1/mcp-servers', 'customAction', {
      forUserId: 'u1',
    });

    expect(result).toEqual({ method: 'customAction' });
    expect(harness.getReauthCalls()).toBe(1);
    expect(harness.getServerCalls()).toBe(2);
  });
});
