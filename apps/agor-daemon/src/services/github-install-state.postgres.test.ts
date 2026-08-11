/**
 * PostgreSQL integration proof for HA-safe GitHub App installation state.
 *
 * Run with:
 *   AGOR_DB_DIALECT=postgresql \
 *   AGOR_TEST_POSTGRES_URL=postgresql://user:pw@host:5432/db \
 *   pnpm --filter @agor/daemon exec vitest run src/services/github-install-state.postgres.test.ts
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  acquireTenantWriteGate,
  createDatabase,
  createTenantScopedDatabaseProxy,
  GitHubInstallStateDiscoveryRepository,
  GitHubInstallStateRepository,
  initializeDatabase,
  isPostgresDatabase,
  type RawDatabase,
  releaseTenantWriteGate,
  runWithSystemDatabaseScope,
  runWithTenantDatabaseScope,
  sql,
  type TenantScopeAwareDatabase,
  TenantWriteGateActiveError,
} from '@agor/core/db';
import type express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerGitHubAppSetupRoutes } from './github-app-setup.js';
import {
  GITHUB_INSTALL_STATE_INTENT,
  GITHUB_INSTALL_STATE_TTL_MS,
  GitHubInstallStateService,
} from './github-install-state.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

type RouteHandler = (req: express.Request, res: express.Response) => unknown;

function routeApp() {
  const routes = new Map<string, RouteHandler>();
  return {
    service(name: string) {
      if (name !== 'authentication') throw new Error(`unexpected service ${name}`);
      return {
        create: async () => ({ user: { user_id: 'admin-route', role: 'admin' } }),
      };
    },
    get(path: string, handler: RouteHandler) {
      routes.set(`GET ${path}`, handler);
    },
    post(path: string, handler: RouteHandler) {
      routes.set(`POST ${path}`, handler);
    },
    route(method: 'GET' | 'POST', path: string): RouteHandler {
      const handler = routes.get(`${method} ${path}`);
      if (!handler) throw new Error(`missing route ${method} ${path}`);
      return handler;
    },
  };
}

function routeResponse(): express.Response & { statusCode: number; body: unknown } {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader(name: string, value: string | number | readonly string[]) {
      this.headers[name] = String(value);
      return this;
    },
  };
  return response as unknown as express.Response & { statusCode: number; body: unknown };
}

function hashState(rawState: string): string {
  return createHash('sha256').update(rawState, 'utf8').digest('hex');
}

async function expireState(
  db: TenantScopeAwareDatabase,
  tenantId: string,
  rawState: string
): Promise<void> {
  await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    await (
      scoped as unknown as { execute(query: unknown): Promise<Array<Record<string, unknown>>> }
    ).execute(sql`
      UPDATE github_install_states
      SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
      WHERE state_hash = ${hashState(rawState)}
    `);
  });
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'GitHubInstallStateService (PostgreSQL)',
  () => {
    let rawA: RawDatabase;
    let rawB: RawDatabase;
    let dbA: TenantScopeAwareDatabase;
    let dbB: TenantScopeAwareDatabase;
    let daemonA: GitHubInstallStateService;
    let daemonB: GitHubInstallStateService;

    beforeAll(async () => {
      rawA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawA);
      rawB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      if (!isPostgresDatabase(rawA) || !isPostgresDatabase(rawB)) {
        throw new Error('PostgreSQL test requires PostgreSQL');
      }
      dbA = createTenantScopedDatabaseProxy(rawA, {
        requireScope: true,
        label: 'GitHub install state daemon A',
      });
      dbB = createTenantScopedDatabaseProxy(rawB, {
        requireScope: true,
        label: 'GitHub install state daemon B',
      });
      daemonA = new GitHubInstallStateService({ db: dbA, startCleanupTimer: false });
      daemonB = new GitHubInstallStateService({ db: dbB, startCleanupTimer: false });
    });

    afterAll(async () => {
      daemonA?.close();
      daemonB?.close();
      await (rawA as RawDatabase & { $client: { end: () => Promise<void> } }).$client.end();
      await (rawB as RawDatabase & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('issues on one client, stores only a hash, and consumes on an independent client', async () => {
      // `default` is deliberate: an unset tenant GUC must not fall through the
      // ordinary tenant policy and bypass the callback-only discovery scope.
      const tenantId = 'default';
      const rawState = await daemonA.issueInstallState('admin-a', tenantId);
      const stateHash = hashState(rawState);

      await runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const rows = await (
          scoped as unknown as { execute(query: unknown): Promise<Array<Record<string, unknown>>> }
        ).execute(sql`
          SELECT state_hash, user_id, intent
          FROM github_install_states
          WHERE state_hash = ${stateHash}
        `);
        expect(rows).toEqual([
          expect.objectContaining({
            state_hash: stateHash,
            user_id: 'admin-a',
            intent: GITHUB_INSTALL_STATE_INTENT,
          }),
        ]);
        expect(JSON.stringify(rows)).not.toContain(rawState);
      });

      await expect(
        runWithSystemDatabaseScope(
          dbB,
          'prove unrelated capability cannot route GitHub state',
          (systemDb) =>
            new GitHubInstallStateDiscoveryRepository(systemDb).findTenantId(
              stateHash,
              GITHUB_INSTALL_STATE_INTENT
            ),
          { capability: 'upload_maintenance' }
        )
      ).resolves.toBeNull();
      await expect(
        runWithSystemDatabaseScope(
          dbB,
          'prove missing capability cannot route default state',
          (systemDb) =>
            new GitHubInstallStateDiscoveryRepository(systemDb).findTenantId(
              stateHash,
              GITHUB_INSTALL_STATE_INTENT
            )
        )
      ).resolves.toBeNull();

      await expect(daemonB.consumeInstallState(rawState)).resolves.toEqual({
        ok: true,
        userId: 'admin-a',
        tenantId,
      });
      await expect(daemonA.consumeInstallState(rawState)).resolves.toEqual({
        ok: false,
        reason: 'unknown',
      });
    });

    it('completes the registered setup callback route on a peer daemon exactly once', async () => {
      const appA = routeApp();
      const appB = routeApp();
      const config = {
        multi_tenancy: { mode: 'static' as const, static_tenant_id: 'default' },
      };
      registerGitHubAppSetupRoutes(appA as never, {
        uiUrl: 'http://ui.test',
        daemonUrl: 'http://daemon-a.test',
        db: dbA,
        config,
        installStates: daemonA,
      });
      registerGitHubAppSetupRoutes(appB as never, {
        uiUrl: 'http://ui.test',
        daemonUrl: 'http://daemon-b.test',
        db: dbB,
        config,
        installStates: daemonB,
      });

      const issueResponse = routeResponse();
      await appA.route('POST', '/api/github/setup/state')(
        { headers: { authorization: 'Bearer valid' }, query: {} } as express.Request,
        issueResponse
      );
      expect(issueResponse.statusCode).toBe(200);
      const rawState = (issueResponse.body as { state: string }).state;

      const callbackResponse = routeResponse();
      await appB.route('GET', '/api/github/setup/callback')(
        { headers: {}, query: { installation_id: '4242', state: rawState } } as express.Request,
        callbackResponse
      );
      expect(callbackResponse.statusCode).toBe(200);
      expect(String(callbackResponse.body)).toMatch(/unverified installation ID/i);

      const replayResponse = routeResponse();
      await appA.route('GET', '/api/github/setup/callback')(
        { headers: {}, query: { installation_id: '4242', state: rawState } } as express.Request,
        replayResponse
      );
      expect(replayResponse.statusCode).toBe(400);
    });

    it('allows exactly one concurrent consume across independent clients', async () => {
      const tenantId = `github-state-race-${randomUUID()}`;
      const rawState = await daemonA.issueInstallState('admin-race', tenantId);

      const results = await Promise.all([
        daemonA.consumeInstallState(rawState),
        daemonB.consumeInstallState(rawState),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: 'unknown' }]);
    });

    it('does not expose or consume tenant A state through tenant B RLS scope', async () => {
      const tenantA = `github-state-tenant-a-${randomUUID()}`;
      const tenantB = `github-state-tenant-b-${randomUUID()}`;
      const rawState = await daemonA.issueInstallState('admin-a', tenantA);
      const stateHash = hashState(rawState);

      await expect(
        runWithTenantDatabaseScope(dbB, tenantB, (scoped) =>
          new GitHubInstallStateRepository(scoped).consume(stateHash, GITHUB_INSTALL_STATE_INTENT)
        )
      ).resolves.toBeNull();

      await expect(daemonB.consumeInstallState(rawState)).resolves.toEqual({
        ok: true,
        userId: 'admin-a',
        tenantId: tenantA,
      });
    });

    it('enforces intent and optional authenticated user/tenant bindings', async () => {
      const tenantId = `github-state-binding-${randomUUID()}`;
      const intentState = await daemonA.issueInstallState('admin-bound', tenantId);
      await expect(
        daemonB.consumeInstallState(intentState, { intent: 'different-flow' })
      ).resolves.toEqual({ ok: false, reason: 'unknown' });
      await expect(daemonB.consumeInstallState(intentState)).resolves.toMatchObject({ ok: true });

      const userState = await daemonA.issueInstallState('admin-bound', tenantId);
      await expect(
        daemonB.consumeInstallState(userState, { expectedUserId: 'other-admin' })
      ).resolves.toEqual({ ok: false, reason: 'user-mismatch' });
      await expect(daemonA.consumeInstallState(userState)).resolves.toEqual({
        ok: false,
        reason: 'unknown',
      });

      const tenantState = await daemonA.issueInstallState('admin-bound', tenantId);
      await expect(
        daemonB.consumeInstallState(tenantState, { expectedTenantId: 'other-tenant' })
      ).resolves.toEqual({ ok: false, reason: 'tenant-mismatch' });
      await expect(daemonA.consumeInstallState(tenantState)).resolves.toEqual({
        ok: false,
        reason: 'unknown',
      });
    });

    it('rejects expired state and cleanup removes abandoned expired rows', async () => {
      const tenantId = `github-state-expiry-${randomUUID()}`;
      const consumedExpired = await daemonA.issueInstallState('admin-expired', tenantId);
      await expireState(dbA, tenantId, consumedExpired);
      await expect(daemonB.consumeInstallState(consumedExpired)).resolves.toEqual({
        ok: false,
        reason: 'expired',
      });

      const abandonedExpired = await daemonA.issueInstallState('admin-expired', tenantId);
      await expireState(dbA, tenantId, abandonedExpired);
      await expect(daemonB.cleanupExpiredStates()).resolves.toBeGreaterThanOrEqual(1);
      await expect(daemonA.consumeInstallState(abandonedExpired)).resolves.toEqual({
        ok: false,
        reason: 'unknown',
      });
    });

    it('uses the PostgreSQL clock for expiry despite issuer clock skew', async () => {
      const tenantId = `github-state-clock-${randomUUID()}`;
      const skewedIssuer = new GitHubInstallStateService({
        db: dbA,
        now: () => new Date('2099-01-01T00:00:00.000Z'),
        startCleanupTimer: false,
      });
      const rawState = await skewedIssuer.issueInstallState('admin-skewed', tenantId);
      const rows = await runWithTenantDatabaseScope(dbA, tenantId, async (scoped) =>
        (
          scoped as unknown as { execute(query: unknown): Promise<Array<Record<string, unknown>>> }
        ).execute(sql`
          SELECT
            abs(extract(epoch FROM (created_at - CURRENT_TIMESTAMP))) AS created_skew_seconds,
            extract(epoch FROM (expires_at - created_at)) AS lifetime_seconds
          FROM github_install_states
          WHERE state_hash = ${hashState(rawState)}
        `)
      );

      expect(Number(rows[0]?.created_skew_seconds)).toBeLessThan(5);
      expect(Number(rows[0]?.lifetime_seconds)).toBe(GITHUB_INSTALL_STATE_TTL_MS / 1_000);
      skewedIssuer.close();
      await daemonB.consumeInstallState(rawState);
    });

    it('honors a tenant write gate for issue, consume, and cleanup', async () => {
      const tenantId = `github-state-gate-${randomUUID()}`;
      const rawState = await daemonA.issueInstallState('admin-gated', tenantId);
      const expiredState = await daemonA.issueInstallState('admin-gated', tenantId);
      await expireState(dbA, tenantId, expiredState);
      const gate = await acquireTenantWriteGate(rawA, tenantId, {
        holder: 'github-install-state-test',
        reason: 'prove custom callback boundary is frozen',
      });

      try {
        await expect(daemonB.issueInstallState('admin-gated', tenantId)).rejects.toBeInstanceOf(
          TenantWriteGateActiveError
        );
        await expect(daemonB.consumeInstallState(rawState)).rejects.toBeInstanceOf(
          TenantWriteGateActiveError
        );
        await expect(daemonB.cleanupExpiredStates()).resolves.toBe(0);
      } finally {
        await releaseTenantWriteGate(rawA, tenantId, { generation: gate.generation });
      }

      await expect(daemonB.consumeInstallState(rawState)).resolves.toMatchObject({ ok: true });
      await expect(daemonB.consumeInstallState(expiredState)).resolves.toEqual({
        ok: false,
        reason: 'expired',
      });
    });

    it('advances bounded cleanup past a write-gated tenant', async () => {
      const suffix = randomUUID();
      const gatedTenant = `github-state-page-a-${suffix}`;
      const laterTenant = `github-state-page-b-${suffix}`;
      const gatedState = await daemonA.issueInstallState('admin-page', gatedTenant);
      const laterState = await daemonA.issueInstallState('admin-page', laterTenant);
      await expireState(dbA, gatedTenant, gatedState);
      await expireState(dbA, laterTenant, laterState);

      const scanner = new GitHubInstallStateService({
        db: dbB,
        cleanupTenantLimit: 1,
        startCleanupTimer: false,
      });
      const gate = await acquireTenantWriteGate(rawA, gatedTenant, {
        holder: 'github-install-state-pagination-test',
        reason: 'prove cleanup advances beyond a gated first page',
      });

      try {
        await expect(scanner.cleanupExpiredStates()).resolves.toBe(0);
        await expect(scanner.cleanupExpiredStates()).resolves.toBe(1);
        await expect(daemonA.consumeInstallState(laterState)).resolves.toEqual({
          ok: false,
          reason: 'unknown',
        });
      } finally {
        await releaseTenantWriteGate(rawA, gatedTenant, { generation: gate.generation });
        scanner.close();
      }

      await expect(daemonB.consumeInstallState(gatedState)).resolves.toEqual({
        ok: false,
        reason: 'expired',
      });
    });
  }
);
