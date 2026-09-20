/**
 * A scope opened for one database must never serve another.
 *
 * The scope stores and the proxy-target map are the PROCESS's (`Symbol.for`,
 * see `processScopeStore` in `tenant-context.ts`), which is what makes core's
 * scoping mean anything in a built artifact where every tsup entry inlines its
 * own copy of these modules. What that sharing did NOT come with was any check
 * that the scope on the store belongs to the database being asked about:
 *
 *  - `scopedTarget` routed every guarded proxy to `store.db`, whatever handle
 *    that was, so a proxy over database B answered from database A's handle;
 *  - `runWithTenantDatabaseScope` joined whatever scope was open, so asking
 *    explicitly for B's scope handed the callback A's handle too.
 *
 * Both are wrong-database routing rather than a demonstrated cross-tenant
 * read, and both are fixed by fencing on database identity — not by changing
 * what a scope means. These cases pin the fence, and the ones at the bottom pin
 * that same-database behaviour is untouched, which is the part a fence like
 * this can plausibly break.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type Database } from './client';
import { initializeDatabase } from './migrate';
import {
  isMCPSlackConnectCardEnabled,
  setMCPSlackConnectCardEnabled,
} from './repositories/mcp-slack-connect-settings';
import {
  createTenantScopedDatabaseProxy,
  MissingTenantDatabaseScopeError,
  runWithSystemDatabaseScope,
  runWithTenantDatabaseScope,
} from './tenant-scope';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

let scratch: string;
/** Two independent databases, told apart by one app variable each. */
let rawA: Database;
let rawB: Database;
let proxyA: ReturnType<typeof createTenantScopedDatabaseProxy>;
let proxyB: ReturnType<typeof createTenantScopedDatabaseProxy>;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'agor-db-identity-'));
  rawA = createDatabase({ url: `file:${join(scratch, 'a.db')}` });
  rawB = createDatabase({ url: `file:${join(scratch, 'b.db')}` });
  await initializeDatabase(rawA);
  await initializeDatabase(rawB);
  // The marker: A's card projection is OFF, B's is ON. Any read that answers
  // `false` through B is answering out of A.
  await setMCPSlackConnectCardEnabled(rawA, false);
  await setMCPSlackConnectCardEnabled(rawB, true);

  proxyA = createTenantScopedDatabaseProxy(rawA, { requireScope: true, label: 'database A' });
  proxyB = createTenantScopedDatabaseProxy(rawB, { requireScope: true, label: 'database B' });
});

afterEach(async () => {
  for (const db of [rawA, rawB]) {
    (db as unknown as { $client?: { close(): void } }).$client?.close();
  }
  await rm(scratch, { recursive: true, force: true });
});

describe('a scope is fenced to the database it was opened on', () => {
  it('refuses a proxy whose database has no scope, inside another database’s scope', async () => {
    // The control, first: outside any scope B's proxy refuses. That much was
    // always right.
    await expect(isMCPSlackConnectCardEnabled(proxyB)).rejects.toBeInstanceOf(
      MissingTenantDatabaseScopeError
    );

    // And inside A's scope it must refuse for the same reason — there is still
    // no scope for B. It used to answer `false`, which is A's value read
    // through A's handle by a proxy that only ever wrapped B.
    await runWithTenantDatabaseScope(proxyA, TENANT_A, async () => {
      await expect(isMCPSlackConnectCardEnabled(proxyB)).rejects.toBeInstanceOf(
        MissingTenantDatabaseScopeError
      );
    });
  });

  it('hands a nested scope the database it asked for', async () => {
    await runWithTenantDatabaseScope(proxyA, TENANT_A, async () => {
      // Asking for B's scope from inside A's used to return A's handle,
      // because admission checked only that *a* scope was open.
      const throughB = await runWithTenantDatabaseScope(proxyB, TENANT_B, (scoped) =>
        isMCPSlackConnectCardEnabled(scoped)
      );
      expect(throughB).toBe(true);
      // The outer scope is still A's afterwards, and still answers A.
      await expect(isMCPSlackConnectCardEnabled(proxyA)).resolves.toBe(false);
    });
  });

  it('writes the row into the database the scope names', async () => {
    await runWithTenantDatabaseScope(proxyA, TENANT_A, async () => {
      await runWithTenantDatabaseScope(proxyB, TENANT_B, (scoped) =>
        setMCPSlackConnectCardEnabled(scoped, false)
      );
    });

    // End state, read straight off the raw handles: B flipped, A untouched.
    await expect(isMCPSlackConnectCardEnabled(rawB)).resolves.toBe(false);
    await expect(isMCPSlackConnectCardEnabled(rawA)).resolves.toBe(false);
    await runWithTenantDatabaseScope(proxyA, TENANT_A, async () => {
      await setMCPSlackConnectCardEnabled(proxyA as Database, true);
    });
    await expect(isMCPSlackConnectCardEnabled(rawA)).resolves.toBe(true);
    await expect(isMCPSlackConnectCardEnabled(rawB)).resolves.toBe(false);
  });

  it('does not let a system scope on one database serve another', async () => {
    await runWithSystemDatabaseScope(proxyA, 'database identity test', async () => {
      await expect(isMCPSlackConnectCardEnabled(proxyB)).rejects.toBeInstanceOf(
        MissingTenantDatabaseScopeError
      );
      // A system scope explicitly requested for B opens on B.
      await expect(
        runWithSystemDatabaseScope(proxyB, 'database identity test', (scoped) =>
          isMCPSlackConnectCardEnabled(scoped)
        )
      ).resolves.toBe(true);
    });
  });
});

/**
 * The reviewer's own shape: two independently evaluated copies of this module.
 *
 * `@agor/core` builds with `splitting: false`, so each tsup entry inlines its
 * own copy; `vi.resetModules()` plus a fresh import is that duplication in one
 * process. Everything the fence relies on — the scope store and the
 * proxy-target map — is `Symbol.for`-keyed and therefore shared between the
 * copies, which is precisely why the missing check was reachable across them.
 */
describe('the fence holds across duplicated copies of this module', () => {
  it('refuses a proxy built by another copy for another database', async () => {
    const first = await import('./tenant-scope');
    vi.resetModules();
    const second = await import('./tenant-scope');
    expect(second).not.toBe(first);

    const firstProxyA = first.createTenantScopedDatabaseProxy(rawA, {
      requireScope: true,
      label: 'database A (copy 1)',
    });
    const secondProxyB = second.createTenantScopedDatabaseProxy(rawB, {
      requireScope: true,
      label: 'database B (copy 2)',
    });

    await first.runWithTenantDatabaseScope(firstProxyA, TENANT_A, async () => {
      // Cross-copy, so match the contract rather than the constructor: each
      // copy owns its own error class.
      await expect(isMCPSlackConnectCardEnabled(secondProxyB)).rejects.toThrow(
        /Missing tenant database scope for database B \(copy 2\) access/
      );
      // A scope opened through the OTHER copy, for B, does serve B.
      await expect(
        second.runWithTenantDatabaseScope(secondProxyB, TENANT_B, (scoped) =>
          isMCPSlackConnectCardEnabled(scoped)
        )
      ).resolves.toBe(true);
    });
  });
});

/**
 * What must not change. A fence on identity is only correct if every handle
 * that names the same database still counts as the same database — including
 * the scoped handle a scope itself produced, and a second proxy over one base.
 */
describe('same-database behaviour is untouched', () => {
  it('joins an already-open scope on the same database', async () => {
    const seen: boolean[] = [];
    await runWithTenantDatabaseScope(proxyA, TENANT_A, async (outer) => {
      seen.push(await isMCPSlackConnectCardEnabled(proxyA));
      // Re-entering with the proxy, with the raw base, and with the scoped
      // handle the scope handed out: three spellings of one database.
      for (const handle of [proxyA, rawA, outer]) {
        seen.push(
          await runWithTenantDatabaseScope(handle, TENANT_A, (scoped) =>
            isMCPSlackConnectCardEnabled(scoped)
          )
        );
      }
    });
    expect(seen).toEqual([false, false, false, false]);
  });

  it('routes a second proxy over the same base, whatever opened the scope', async () => {
    const alsoA = createTenantScopedDatabaseProxy(rawA, {
      requireScope: true,
      label: 'database A, again',
    });
    await runWithTenantDatabaseScope(proxyA, TENANT_A, async () => {
      await expect(isMCPSlackConnectCardEnabled(alsoA)).resolves.toBe(false);
    });
    // …and a proxy over a proxy unwraps the whole way down to the same base.
    const overProxy = createTenantScopedDatabaseProxy(proxyA, {
      requireScope: true,
      label: 'database A, wrapped twice',
    });
    await runWithTenantDatabaseScope(rawA, TENANT_A, async () => {
      await expect(isMCPSlackConnectCardEnabled(overProxy)).resolves.toBe(false);
    });
  });

  it('still refuses to switch tenants inside one database’s scope', async () => {
    await expect(
      runWithTenantDatabaseScope(proxyA, TENANT_A, () =>
        runWithTenantDatabaseScope(proxyA, TENANT_B, async () => undefined)
      )
    ).rejects.toThrow(/Cannot enter tenant scope tenant-b from active tenant scope tenant-a/);
  });
});
