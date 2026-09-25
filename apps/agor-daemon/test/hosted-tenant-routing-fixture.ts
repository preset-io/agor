/**
 * A hosted deployment (`multi_tenancy.mode: required_from_auth`), as a caller
 * that builds a user-facing link sees it.
 *
 * Exists because of a failure no suite could reproduce. Under hosted mode
 * `getBaseUrl` ignores `AGOR_BASE_URL` entirely and resolves the tenant's own
 * origin from durable routing, which needs a database handle or an ambient
 * tenant database scope. Every automated drive of the Slack MCP connect lane
 * ran SQLite and single-tenant, where that branch is never taken — so two call
 * sites that passed no handle at all were inert in every test and threw
 * "Tenant public links require a tenant database" on the first line of the
 * real cloud stack.
 *
 * What this gives a test is therefore the whole hosted shape at once: the
 * config that takes the branch, a real migrated database behind
 * `requireScope: true` so an unscoped read is refused rather than silently
 * answered, a deployment-wide `AGOR_BASE_URL` that must never appear in a
 * tenant's link, and either an observed tenant origin or none — the
 * uninitialised case that makes `getBaseUrl` answer `''` rather than throw.
 *
 * See `docs/internal/slack-mcp-oauth-connect-2026-09-16.md` §7.1.14.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { __resetConfigCacheForTests } from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import {
  createDatabaseAsync,
  createTenantScopedDatabaseProxy,
  runMigrations,
  runWithTenantDatabaseTransaction,
  TenantPublicRoutingRepository,
} from '@agor/core/db';

/** Env this fixture owns for the duration of a test. */
const OWNED_ENV = ['HOME', 'USERPROFILE', 'AGOR_BASE_URL', 'AGOR_DB_DIALECT', 'DATABASE_URL'];

export interface HostedTenantRouting {
  /** Scope-guarded handle, the shape services actually hold in production. */
  db: TenantScopeAwareDatabase;
  /** The tenant's public origin, or `''` when no launch has been observed. */
  origin: string;
  /** The deployment-wide origin hosted mode must never substitute. */
  cellBaseUrl: string;
  cleanup(): Promise<void>;
}

export async function hostedTenantRouting(options: {
  tenantId: string;
  /** Omit to model a tenant whose verified launch has not landed yet. */
  origin?: string;
  cellBaseUrl?: string;
}): Promise<HostedTenantRouting> {
  const previous = Object.fromEntries(OWNED_ENV.map((key) => [key, process.env[key]]));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-hosted-routing-'));
  const cellBaseUrl = options.cellBaseUrl ?? 'https://cell.example.test';
  let db: TenantScopeAwareDatabase | undefined;

  const cleanup = async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    __resetConfigCacheForTests();
    await fs.rm(home, { recursive: true, force: true });
  };

  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.AGOR_BASE_URL = cellBaseUrl;
    delete process.env.AGOR_DB_DIALECT;
    delete process.env.DATABASE_URL;
    await fs.mkdir(path.join(home, '.agor'));
    await fs.writeFile(
      path.join(home, '.agor/config.yaml'),
      `database:
  dialect: postgresql
multi_tenancy:
  mode: required_from_auth
  auth_claim: tenant_id
  filesystem_isolation_enabled: true
execution:
  branch_storage:
    default_mode: clone
    allowed_modes: [clone]
`
    );
    __resetConfigCacheForTests();

    // SQLite standing in for the hosted database is deliberate and sufficient:
    // what is under test is which ORIGIN a link is built from, and that is
    // decided by `multi_tenancy.mode` plus the routing row, neither of which
    // is dialect-specific. Shared-database isolation stays with the Postgres
    // suites.
    const raw = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
    await runMigrations(raw);
    if (options.origin) {
      await runWithTenantDatabaseTransaction(raw, options.tenantId, (scoped) =>
        new TenantPublicRoutingRepository(scoped).observeVerifiedLaunch({
          public_base_url: options.origin as string,
          assertion_issued_at: 100,
        })
      );
    }
    db = createTenantScopedDatabaseProxy(raw, {
      requireScope: true,
      label: 'hosted tenant routing fixture',
    }) as unknown as TenantScopeAwareDatabase;
  } catch (error) {
    await cleanup();
    throw error;
  }

  return { db, origin: options.origin ?? '', cellBaseUrl, cleanup };
}
