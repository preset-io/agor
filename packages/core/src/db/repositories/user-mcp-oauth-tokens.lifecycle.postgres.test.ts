import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { UserID } from '../../types';
import { createDatabase, type Database } from '../client';
import { deleteFrom, executeRaw, rawRows } from '../database-wrapper';
import { runMigrations } from '../migrate';
import { users } from '../schema';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { MCPServerRepository } from './mcp-servers';
import { type SaveTokenInput, UserMCPOAuthTokenRepository } from './user-mcp-oauth-tokens';
import { UsersRepository } from './users';

const url = process.env.AGOR_TEST_POSTGRES_URL;
const secret = 'synthetic-attribution-lifecycle-master';
const input = (generation = 1): SaveTokenInput => ({
  accessToken: `access-${generation}`,
  refreshToken: `refresh-${generation}`,
  clientId: 'client',
  grantBinding: {
    generation,
    version: 4,
    fingerprint: 'a'.repeat(64),
    metadataUri: 'https://provider.example.test/metadata',
    resourceUri: 'https://provider.example.test/mcp',
    issuer: 'https://provider.example.test',
    authorizationEndpoint: 'https://provider.example.test/authorize',
    tokenEndpoint: 'https://provider.example.test/token',
    redirectUri: 'https://agor.example.test/callback',
  },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Independent pools model deletion and callback/refresh workers. No superuser
// connection is used, even for migrations or lock observation.
describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'shared grant lifecycle under PostgreSQL RLS',
  () => {
    let db: Database;
    let peer: Database;
    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: url! });
      peer = createDatabase({ dialect: 'postgresql', url: url! });
      await runMigrations(db);
      expect(
        rawRows(
          await executeRaw(
            db,
            sql`SELECT rolsuper, rolbypassrls FROM pg_roles
      WHERE rolname = current_user`
          )
        )
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    });
    afterAll(async () => {
      for (const pool of [db, peer]) {
        await (pool as Database & { $client: { end(): Promise<void> } }).$client.end();
      }
    });
    const repo = (scoped: Database) => new UserMCPOAuthTokenRepository(scoped, secret);
    async function seed() {
      const tenant = `attribution-${crypto.randomUUID()}`;
      return runWithTenantDatabaseScope(db, tenant, async (scoped) => {
        const principals = new UsersRepository(scoped);
        const create = () =>
          principals.create({ email: `${crypto.randomUUID()}@example.test`, role: 'admin' });
        const a = await create();
        const b = await create();
        const owner = await create();
        const server = await new MCPServerRepository(scoped).create({
          name: `shared-${crypto.randomUUID()}`,
          transport: 'http',
          url: 'https://provider.example.test/mcp',
          scope: 'global',
          enabled: true,
          source: 'user',
          owner_user_id: owner.user_id,
          auth: { type: 'oauth', oauth_mode: 'shared' },
        });
        return {
          tenant,
          a: a.user_id,
          b: b.user_id,
          owner: owner.user_id,
          serverId: server.mcp_server_id,
        };
      });
    }
    async function waitBlocked(pid: number, blocker?: number) {
      await vi.waitFor(
        async () => {
          const row = rawRows(
            await executeRaw(db, sql`SELECT pg_blocking_pids(${pid}) AS blockers`)
          )[0];
          const blockers = row.blockers as number[];
          if (blocker === undefined) expect(blockers.length).toBeGreaterThan(0);
          else expect(blockers).toContain(blocker);
        },
        { timeout: 5000, interval: 10 }
      );
    }
    async function backendPid(scoped: Database) {
      return Number(rawRows(await executeRaw(scoped, sql`SELECT pg_backend_pid() AS pid`))[0].pid);
    }

    it('cascades only grants attributed to the deleted user, independently of server ownership', async () => {
      const f = await seed();
      await runWithTenantDatabaseScope(db, f.tenant, async (scoped) => {
        await repo(scoped).saveToken(f.a, f.serverId, input());
        await repo(scoped).saveToken(f.b, f.serverId, input());
        await repo(scoped).saveToken(null, f.serverId, input(), f.a);
        await new UsersRepository(scoped).delete(f.owner);
        expect(await repo(scoped).getToken(null, f.serverId)).toMatchObject({
          granted_by_user_id: f.a,
        });
        await new UsersRepository(scoped).delete(f.a);
        expect(await repo(scoped).getToken(null, f.serverId)).toBeNull();
        expect(await repo(scoped).getToken(f.a, f.serverId)).toBeNull();
        expect(await repo(scoped).getToken(f.b, f.serverId)).toMatchObject({
          granted_by_user_id: f.b,
        });
        expect(await repo(scoped).hasValidToken(null, f.serverId)).toBe(false);
      });
    });

    it('preserves attribution through refresh and fences completion after direct-FK deletion', async () => {
      const f = await seed();
      const claim = await runWithTenantDatabaseScope(db, f.tenant, async (scoped) => {
        await repo(scoped).saveToken(null, f.serverId, input(), f.a);
        return repo(scoped).claimRefresh(null, f.serverId, {
          grantGeneration: 1,
          grantBindingFingerprint: input().grantBinding!.fingerprint,
          refreshGeneration: 0,
        });
      });
      if (claim.outcome !== 'claimed') throw new Error('Expected refresh claim');
      await runWithTenantDatabaseScope(peer, f.tenant, async (scoped) => {
        expect(
          await repo(scoped).completeClaimedRefresh(null, f.serverId, claim, {
            accessToken: 'rotated',
            expiresAt: null,
          })
        ).toBe(true);
        expect(await repo(scoped).getToken(null, f.serverId)).toMatchObject({
          granted_by_user_id: f.a,
          oauth_access_token: 'rotated',
        });
      });
      const pending = await runWithTenantDatabaseScope(db, f.tenant, (scoped) =>
        repo(scoped).claimRefresh(null, f.serverId, {
          grantGeneration: 1,
          grantBindingFingerprint: input().grantBinding!.fingerprint,
          refreshGeneration: 1,
        })
      );
      if (pending.outcome !== 'claimed') throw new Error('Expected second refresh claim');
      await runWithTenantDatabaseScope(peer, f.tenant, (scoped) =>
        deleteFrom(scoped, users).where(eq(users.user_id, f.a)).run()
      );
      await runWithTenantDatabaseScope(db, f.tenant, async (scoped) => {
        expect(
          await repo(scoped).completeClaimedRefresh(null, f.serverId, pending, {
            accessToken: 'late',
            expiresAt: null,
          })
        ).toBe(false);
        expect(await repo(scoped).getToken(null, f.serverId)).toBeNull();
      });
      await expect(
        runWithTenantDatabaseScope(db, f.tenant, (scoped) =>
          repo(scoped).saveToken(null, f.serverId, input(2), f.a)
        )
      ).rejects.toThrow(/no longer available/);
    });

    it('keeps B replacement after deleting A and refuses A refresh or stale replacement', async () => {
      const f = await seed();
      const claim = await runWithTenantDatabaseScope(db, f.tenant, async (scoped) => {
        await repo(scoped).saveToken(null, f.serverId, input(), f.a);
        return repo(scoped).claimRefresh(null, f.serverId, {
          grantGeneration: 1,
          grantBindingFingerprint: input().grantBinding!.fingerprint,
          refreshGeneration: 0,
        });
      });
      if (claim.outcome !== 'claimed') throw new Error('Expected claim');
      await runWithTenantDatabaseScope(peer, f.tenant, (scoped) =>
        repo(scoped).saveToken(null, f.serverId, input(2), f.b)
      );
      await expect(
        runWithTenantDatabaseScope(db, f.tenant, (scoped) =>
          repo(scoped).saveToken(null, f.serverId, input(), f.a)
        )
      ).rejects.toThrow(/superseded/);
      await runWithTenantDatabaseScope(db, f.tenant, async (scoped) => {
        await deleteFrom(scoped, users).where(eq(users.user_id, f.a)).run();
        expect(
          await repo(scoped).completeClaimedRefresh(null, f.serverId, claim, {
            accessToken: 'late-a',
            expiresAt: null,
          })
        ).toBe(false);
        expect(await repo(scoped).deleteClaimedInvalidGrant(null, f.serverId, claim)).toBe(false);
        expect(await repo(scoped).getToken(null, f.serverId)).toMatchObject({
          granted_by_user_id: f.b,
          oauth_access_token: 'access-2',
        });
      });
    });

    it('does not cascade B replacement when A deletion waits on the replaced row', async () => {
      const f = await seed();
      await runWithTenantDatabaseScope(db, f.tenant, (scoped) =>
        repo(scoped).saveToken(null, f.serverId, input(), f.a)
      );
      const replaced = deferred<number>();
      const release = deferred<void>();
      const deletingPid = deferred<number>();
      const replacement = runWithTenantDatabaseScope(peer, f.tenant, async (scoped) => {
        await repo(scoped).saveToken(null, f.serverId, input(2), f.b);
        replaced.resolve(await backendPid(scoped));
        await release.promise;
      });
      const replacementPid = await replaced.promise;
      const deletion = runWithTenantDatabaseScope(db, f.tenant, async (scoped) => {
        deletingPid.resolve(await backendPid(scoped));
        await new UsersRepository(scoped).delete(f.a);
      });
      try {
        await waitBlocked(await deletingPid.promise, replacementPid);
      } finally {
        release.resolve();
      }
      await Promise.all([replacement, deletion]);
      await runWithTenantDatabaseScope(db, f.tenant, async (scoped) => {
        expect(await repo(scoped).getToken(null, f.serverId)).toMatchObject({
          granted_by_user_id: f.b,
          oauth_access_token: 'access-2',
        });
      });
    });

    it('waits for an uncommitted hard deletion and rejects late callback persistence', async () => {
      const f = await seed();
      const deleted = deferred<void>();
      const release = deferred<void>();
      const savingPid = deferred<number>();
      const deletion = runWithTenantDatabaseScope(peer, f.tenant, async (scoped) => {
        await deleteFrom(scoped, users).where(eq(users.user_id, f.a)).run();
        deleted.resolve();
        await release.promise;
      });
      await deleted.promise;
      const saving = runWithTenantDatabaseScope(db, f.tenant, async (scoped) => {
        savingPid.resolve(await backendPid(scoped));
        await repo(scoped).saveToken(null, f.serverId, input(), f.a);
      });
      const rejected = expect(saving).rejects.toThrow(/no longer available/);
      try {
        await waitBlocked(await savingPid.promise);
      } finally {
        release.resolve();
      }
      await deletion;
      await rejected;
      await runWithTenantDatabaseScope(db, f.tenant, async (scoped) =>
        expect(await repo(scoped).getToken(null, f.serverId)).toBeNull()
      );
    });

    it('locks the consenter before a contended token write, never reversing cascade order', async () => {
      const f = await seed();
      await runWithTenantDatabaseScope(db, f.tenant, (scoped) =>
        repo(scoped).saveToken(null, f.serverId, input(), f.b)
      );
      const locked = deferred<void>();
      const release = deferred<void>();
      const savingPid = deferred<number>();
      const deletingPid = deferred<number>();
      const blocker = runWithTenantDatabaseScope(peer, f.tenant, async (scoped) => {
        await executeRaw(
          scoped,
          sql`SELECT mcp_server_id FROM user_mcp_oauth_tokens WHERE mcp_server_id = ${f.serverId} FOR UPDATE`
        );
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      const saving = runWithTenantDatabaseScope(db, f.tenant, async (scoped) => {
        savingPid.resolve(await backendPid(scoped));
        await repo(scoped).saveToken(null, f.serverId, input(2), f.a);
      });
      let deletion: Promise<unknown> | undefined;
      try {
        const savePid = await savingPid.promise;
        await waitBlocked(savePid);
        deletion = runWithTenantDatabaseScope(peer, f.tenant, async (scoped) => {
          deletingPid.resolve(await backendPid(scoped));
          await deleteFrom(scoped, users).where(eq(users.user_id, f.a)).run();
        });
        await waitBlocked(await deletingPid.promise, savePid);
      } finally {
        release.resolve();
      }
      await Promise.all([blocker, saving, deletion]);
      await runWithTenantDatabaseScope(db, f.tenant, async (scoped) =>
        expect(await repo(scoped).getToken(null, f.serverId)).toBeNull()
      );
    });

    it('rejects cross-tenant attribution, foreign servers and direct DB null/mismatched identities', async () => {
      const a = await seed();
      const b = await seed();
      await runWithTenantDatabaseScope(db, a.tenant, (scoped) =>
        repo(scoped).saveToken(null, a.serverId, input(), a.a)
      );
      await expect(
        runWithTenantDatabaseScope(db, a.tenant, (scoped) =>
          repo(scoped).saveToken(null, a.serverId, input(2), b.a)
        )
      ).rejects.toThrow(/no longer available/);
      await expect(
        runWithTenantDatabaseScope(db, b.tenant, (scoped) =>
          repo(scoped).saveToken(null, a.serverId, input(2), b.a)
        )
      ).rejects.toThrow();
      const invalidWrites = [
        sql`UPDATE user_mcp_oauth_tokens SET granted_by_user_id = ${b.a} WHERE mcp_server_id = ${a.serverId}`,
        sql`INSERT INTO user_mcp_oauth_tokens (tenant_id, granted_by_user_id, mcp_server_id, oauth_access_token, created_at)
          VALUES (${a.tenant}, ${a.a}, ${b.serverId}, 'foreign-server', CURRENT_TIMESTAMP)`,
        sql`INSERT INTO user_mcp_oauth_tokens (tenant_id, granted_by_user_id, mcp_server_id, oauth_access_token, created_at)
          VALUES (${b.tenant}, ${b.a}, ${b.serverId}, 'foreign-tenant', CURRENT_TIMESTAMP)`,
        sql`UPDATE user_mcp_oauth_tokens SET granted_by_user_id = NULL WHERE mcp_server_id = ${a.serverId}`,
        sql`INSERT INTO user_mcp_oauth_tokens (tenant_id, user_id, granted_by_user_id, mcp_server_id, oauth_access_token, created_at)
          VALUES (${a.tenant}, ${a.a}, ${a.b}, ${a.serverId}, 'mismatched', CURRENT_TIMESTAMP)`,
      ];
      for (const write of invalidWrites) {
        await expect(
          runWithTenantDatabaseScope(db, a.tenant, (scoped) => executeRaw(scoped, write))
        ).rejects.toThrow();
      }
      await runWithTenantDatabaseScope(db, b.tenant, async (scoped) => {
        expect(await repo(scoped).getToken(null, a.serverId)).toBeNull();
        expect(await repo(scoped).listShared()).toEqual([]);
        expect(await repo(scoped).deleteToken(null, a.serverId)).toBe(false);
        await deleteFrom(scoped, users).where(eq(users.user_id, a.a)).run();
      });
      await runWithTenantDatabaseScope(db, a.tenant, async (scoped) => {
        expect(await repo(scoped).getToken(null, a.serverId)).toMatchObject({
          granted_by_user_id: a.a,
          oauth_access_token: 'access-1',
        });
      });
      await expect(repo(db).saveToken(null, a.serverId, input(), a.a as UserID)).rejects.toThrow(
        /tenant scope/
      );
    });
  }
);
