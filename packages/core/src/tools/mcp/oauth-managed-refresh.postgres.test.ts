import {
  executeRaw,
  MCPManagedOAuthOutboxRepository,
  runWithTenantDatabaseScope,
  UserMCPOAuthTokenRepository,
} from '@agor/core/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  managedCommit,
  seedManagedRefreshGrant,
} from '../../db/test-support/managed-oauth-fixture';
import { createOwnedPostgres, type OwnedPostgres } from '../../db/test-support/owned-postgres';
import type {
  MCPManagedOAuthRefreshAdapter,
  MCPManagedOAuthTokenCommit,
} from '../../types/mcp-managed-oauth';
import {
  type ManagedMCPOAuthClient,
  ManagedMCPOAuthOperationError,
  ManagedMCPOAuthProtocolError,
} from './managed-oauth-client';
import {
  createManagedOAuthRefreshAdapter,
  getManagedOAuthDeferredRefresh,
  ManagedRefreshInProgressError,
  type RefreshAndPersistDeps,
  refreshAndPersistToken,
} from './oauth-refresh';

const master = 'synthetic-managed-refresh-test-master';
describe.skipIf(process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'managed operations under the existing refresh owner (non-owner PG)',
  () => {
    let owned: OwnedPostgres;
    const original = process.env.AGOR_MASTER_SECRET;
    beforeAll(async () => {
      owned = await createOwnedPostgres();
      process.env.AGOR_MASTER_SECRET = master;
    }, 120000);
    afterAll(async () => {
      await owned?.dispose();
      if (original === undefined) delete process.env.AGOR_MASTER_SECRET;
      else process.env.AGOR_MASTER_SECRET = original;
    }, 30000);
    function deps(
      f: Awaited<ReturnType<typeof seedManagedRefreshGrant>>,
      managed?: MCPManagedOAuthRefreshAdapter
    ): RefreshAndPersistDeps {
      return {
        db: owned.db,
        tenantId: f.tenant,
        userId: f.user,
        mcpServerId: f.server,
        observedRefreshVersion: f.expected,
        validateGrant: () => true,
        managed,
      };
    }
    const commitFor: MCPManagedOAuthRefreshAdapter['execute'] = async ({ request, metadata }) => {
      const commit = managedCommit(request.owner, request.claim, request.sequence, request.handle);
      commit.metadata.transaction_id = metadata.transaction_id;
      return commit;
    };
    it('is off without the injected adapter and never falls back to provider transport', async () => {
      const f = await seedManagedRefreshGrant(owned.db, master);
      const fetch = vi.spyOn(globalThis, 'fetch');
      try {
        await expect(refreshAndPersistToken(deps(f))).rejects.toThrow('adapter is disabled');
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        fetch.mockRestore();
      }
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) =>
        expect(
          (await new UserMCPOAuthTokenRepository(db).getToken(f.user, f.server))?.refresh_status
        ).toBe('idle')
      );
    });
    it('commits rotated tokens and signed material before ACK; ACK failure cannot invalidate the grant', async () => {
      const f = await seedManagedRefreshGrant(owned.db, master);
      const execute = vi.fn(commitFor);
      const acknowledge = vi.fn(async (commit: MCPManagedOAuthTokenCommit) => {
        await runWithTenantDatabaseScope(owned.peer, f.tenant, async (db) =>
          expect(
            (await new UserMCPOAuthTokenRepository(db).getToken(f.user, f.server))?.managed_metadata
          ).toEqual(commit.metadata)
        );
        throw new Error('synthetic ACK network loss');
      });
      const access = await refreshAndPersistToken(deps(f, { execute, acknowledge }));
      expect(access).not.toBe(f.commit.tokens.access_token);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(acknowledge).toHaveBeenCalledTimes(1);
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) =>
        expect(await new MCPManagedOAuthOutboxRepository(db).listPending(f.tenant)).toEqual([])
      );
    });
    it('recovers only the original receipt after owner loss without allocating or replaying a refresh', async () => {
      const f = await seedManagedRefreshGrant(owned.db, master);
      const claimed = await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        new UserMCPOAuthTokenRepository(db).claimRefresh(f.user, f.server, f.expected)
      );
      if (claimed.outcome !== 'claimed') throw new Error('fixture claim');
      const execute = vi.fn(commitFor);
      await refreshAndPersistToken(deps(f, { execute, acknowledge: async () => {} }));
      expect(execute).toHaveBeenCalledTimes(1);
      const args = execute.mock.calls[0][0];
      expect(args.recoveryOnly).toBe(true);
      expect(args.request.operation_id).toBe(claimed.token.managed_operation_id);
      expect(args.request.claim.claimed_at).toBe(claimed.token.refresh_claimed_at!.getTime());
      expect(args.request.claim.refresh_generation).toBe('1');
    });
    it.each(['receipt not found', 'network failure', 'in_progress timeout', 'invalid response'])(
      'does not let a peer %s retire the paused dispatch owner',
      async (failure) => {
        const f = await seedManagedRefreshGrant(owned.db, master);
        let releaseOwner!: () => void;
        let ownerStarted!: () => void;
        const paused = new Promise<void>((resolve) => {
          releaseOwner = resolve;
        });
        const started = new Promise<void>((resolve) => {
          ownerStarted = resolve;
        });
        const ownerExecute = vi.fn<MCPManagedOAuthRefreshAdapter['execute']>(async (args) => {
          expect(args.recoveryOnly).toBe(false);
          // A owns the persisted claim but has not yet reached the broker journal.
          ownerStarted();
          await paused;
          return commitFor(args);
        });
        const owner = refreshAndPersistToken(
          deps(f, {
            execute: ownerExecute,
            acknowledge: async () => {},
          })
        );
        await started;
        const before = await runWithTenantDatabaseScope(owned.peer, f.tenant, (db) =>
          new UserMCPOAuthTokenRepository(db).getToken(f.user, f.server)
        );
        const request = vi.fn(async (args) => {
          expect(args.operation).toBe('receipt');
          expect(args.id).toBe(before!.managed_operation_id);
          expect(args.body.claim.claim_id).toBe(before!.refresh_claim_id);
          expect(args.body).not.toHaveProperty('refresh_token');
          if (failure === 'receipt not found')
            throw new ManagedMCPOAuthProtocolError('remote_rejection');
          if (failure === 'network failure') throw new Error('synthetic network loss');
          if (failure === 'invalid response')
            throw new ManagedMCPOAuthProtocolError('invalid_response');
          return {
            protocol_version: 1,
            operation_id: args.id,
            owner: args.body.owner,
            claim: args.body.claim,
            status: 'in_progress',
            failure_code: 'operation_in_progress',
            sequence: before!.managed_metadata!.next_sequence,
          };
        });
        const peerAdapter = createManagedOAuthRefreshAdapter({
          client: { request } as unknown as ManagedMCPOAuthClient,
          issuer: 'https://broker.example.test/',
          keys: new Map(),
          now: () => Date.now(),
          assertCurrent: () => {},
          acknowledge: async () => {},
        });
        try {
          const error = await refreshAndPersistToken({
            ...deps(f, peerAdapter),
            db: owned.peer,
          }).catch((error) => error);
          expect(error).toBeInstanceOf(ManagedRefreshInProgressError);
          expect(getManagedOAuthDeferredRefresh(error)).toBeUndefined();
          expect(request).toHaveBeenCalled();
          await runWithTenantDatabaseScope(owned.peer, f.tenant, async (db) => {
            expect(await new UserMCPOAuthTokenRepository(db).getToken(f.user, f.server)).toEqual(
              before
            );
            expect(await new MCPManagedOAuthOutboxRepository(db).listPending(f.tenant)).toEqual([]);
          });
        } finally {
          releaseOwner();
        }
        const access = await owner;
        expect(ownerExecute).toHaveBeenCalledTimes(1);
        await runWithTenantDatabaseScope(owned.peer, f.tenant, async (db) => {
          const token = (await new UserMCPOAuthTokenRepository(db).getToken(f.user, f.server))!;
          expect(token.refresh_status).toBe('idle');
          expect(token.refresh_success_generation).toBe(1);
          expect(token.oauth_access_token).toBe(access);
          expect(token.managed_metadata!.operation_id).toBe(before!.managed_operation_id);
          expect(await new MCPManagedOAuthOutboxRepository(db).listPending(f.tenant)).toEqual([]);
        });
      },
      25000
    );
    it('returns the exact committed winner when a peer receipt read fails after owner commit', async () => {
      const f = await seedManagedRefreshGrant(owned.db, master);
      let releaseOwner!: () => void;
      let ownerStarted!: () => void;
      const paused = new Promise<void>((resolve) => {
        releaseOwner = resolve;
      });
      const started = new Promise<void>((resolve) => {
        ownerStarted = resolve;
      });
      const owner = refreshAndPersistToken(
        deps(f, {
          execute: async (args) => {
            ownerStarted();
            await paused;
            return commitFor(args);
          },
          acknowledge: async () => {},
        })
      );
      await started;
      const peer = await refreshAndPersistToken({
        ...deps(f, {
          execute: async (args) => {
            expect(args.recoveryOnly).toBe(true);
            releaseOwner();
            await owner;
            throw new ManagedMCPOAuthProtocolError('unavailable');
          },
          acknowledge: async () => {},
        }),
        db: owned.peer,
      });
      expect(peer).toBe(await owner);
      await runWithTenantDatabaseScope(owned.peer, f.tenant, async (db) => {
        expect(await new MCPManagedOAuthOutboxRepository(db).listPending(f.tenant)).toEqual([]);
      });
    });
    it('keeps a lost owner response recoverable by its original receipt rather than closing the grant', async () => {
      const f = await seedManagedRefreshGrant(owned.db, master);
      const execute = vi.fn<MCPManagedOAuthRefreshAdapter['execute']>(async (args) => {
        if (!args.recoveryOnly) throw new ManagedMCPOAuthProtocolError('unavailable');
        return commitFor(args);
      });
      const adapter = { execute, acknowledge: async () => {} };
      const error = await refreshAndPersistToken(deps(f, adapter)).catch((error) => error);
      expect(error).toBeInstanceOf(ManagedRefreshInProgressError);
      expect(getManagedOAuthDeferredRefresh(error)).toBeUndefined();
      const original = execute.mock.calls[0][0];
      const access = await refreshAndPersistToken({ ...deps(f, adapter), db: owned.peer });
      expect(execute).toHaveBeenCalledTimes(2);
      const recovered = execute.mock.calls[1][0];
      expect(recovered.recoveryOnly).toBe(true);
      expect(recovered.request).toEqual(original.request);
      await runWithTenantDatabaseScope(owned.peer, f.tenant, async (db) => {
        const token = (await new UserMCPOAuthTokenRepository(db).getToken(f.user, f.server))!;
        expect(token.refresh_status).toBe('idle');
        expect(token.oauth_access_token).toBe(access);
        expect(token.managed_metadata!.next_sequence).toBe('2');
        expect(await new MCPManagedOAuthOutboxRepository(db).listPending(f.tenant)).toEqual([]);
      });
    });
    it('keeps certified app-client failure distinct from invalid_grant and advances sequence exactly once', async () => {
      const f = await seedManagedRefreshGrant(owned.db, master);
      const onInvalidGrant = vi.fn();
      const adapter: MCPManagedOAuthRefreshAdapter = {
        acknowledge: async () => {},
        execute: async ({ request }) => {
          throw new ManagedMCPOAuthOperationError({
            protocol_version: 1,
            operation_id: request.operation_id,
            owner: request.owner,
            claim: request.claim,
            status: 'client_configuration_failed',
            failure_code: 'client_configuration_failed',
            sequence: request.sequence,
            next_sequence: String(BigInt(request.sequence) + 1n),
          });
        },
      };
      await expect(
        refreshAndPersistToken({ ...deps(f, adapter), onInvalidGrant })
      ).rejects.toBeInstanceOf(ManagedMCPOAuthOperationError);
      expect(onInvalidGrant).not.toHaveBeenCalled();
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        const token = (await new UserMCPOAuthTokenRepository(db).getToken(f.user, f.server))!;
        expect(token.refresh_status).toBe('idle');
        expect(token.managed_metadata?.next_sequence).toBe('2');
        expect(token.managed_metadata?.use_authorization).toBe(f.commit.metadata.use_authorization);
        expect(await new MCPManagedOAuthOutboxRepository(db).listPending(f.tenant)).toEqual([]);
      });
    });
    it('certifies a peer backoff observation without allocating or dispatching another refresh', async () => {
      const f = await seedManagedRefreshGrant(owned.db, master);
      const execute = vi.fn<MCPManagedOAuthRefreshAdapter['execute']>(async ({ request }) => {
        throw new ManagedMCPOAuthOperationError({
          protocol_version: 1,
          operation_id: request.operation_id,
          owner: request.owner,
          claim: request.claim,
          status: 'rejected_non_consuming',
          failure_code: 'provider_rate_limited',
          sequence: request.sequence,
          next_sequence: String(BigInt(request.sequence) + 1n),
          retry_after_ms: 60000,
        });
      });
      const adapter = { execute, acknowledge: async () => {} };
      const first = await refreshAndPersistToken(deps(f, adapter)).catch((error) => error);
      const fence = getManagedOAuthDeferredRefresh(first);
      expect(fence).toMatchObject({ ...f.expected, refreshGeneration: 1 });
      const retained = await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        new UserMCPOAuthTokenRepository(db).getToken(f.user, f.server)
      );
      const peer = await refreshAndPersistToken({
        ...deps(f, adapter),
        db: owned.peer,
        observedRefreshVersion: fence!,
      }).catch((error) => error);
      expect(getManagedOAuthDeferredRefresh(peer)).toEqual(fence);
      expect(execute).toHaveBeenCalledTimes(1);
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        expect(await new UserMCPOAuthTokenRepository(db).getToken(f.user, f.server)).toEqual(
          retained
        );
      });
    });
    it('expires an unrecovered original claim at the database deadline without replay or a new claim', async () => {
      const f = await seedManagedRefreshGrant(owned.db, master);
      const execute = vi.fn<MCPManagedOAuthRefreshAdapter['execute']>(async () => {
        throw new ManagedMCPOAuthProtocolError('unavailable');
      });
      const d = deps(f, { execute, acknowledge: async () => {} });
      await expect(refreshAndPersistToken(d)).rejects.toBeInstanceOf(ManagedRefreshInProgressError);
      await expect(refreshAndPersistToken({ ...d, db: owned.peer })).rejects.toBeInstanceOf(
        ManagedRefreshInProgressError
      );
      expect(execute.mock.calls.map(([args]) => args.recoveryOnly)).toEqual([false, true]);
      expect(execute.mock.calls[1][0].request).toEqual(execute.mock.calls[0][0].request);
      await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        executeRaw(
          db,
          sql`UPDATE user_mcp_oauth_tokens SET refresh_claimed_at=clock_timestamp()-interval '2 minutes'
          WHERE user_id=${f.user} AND mcp_server_id=${f.server}`
        )
      );
      await expect(refreshAndPersistToken({ ...d, db: owned.peer })).rejects.toThrow('ambiguous');
      expect(execute).toHaveBeenCalledTimes(2);
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        const token = (await new UserMCPOAuthTokenRepository(db).getToken(f.user, f.server))!;
        expect(token.refresh_generation).toBe(1);
        expect(token.refresh_status).toBe('ambiguous');
        expect((await new MCPManagedOAuthOutboxRepository(db).listPending(f.tenant))[0].kind).toBe(
          'close'
        );
      });
    });
    it('releases only a new owner known locally not to have dispatched when caller authority changes', async () => {
      const f = await seedManagedRefreshGrant(owned.db, master);
      const execute = vi.fn(commitFor);
      await expect(
        refreshAndPersistToken({
          ...deps(f, { execute, acknowledge: async () => {} }),
          assertCurrent: () => {
            throw new Error('caller canceled');
          },
        })
      ).rejects.toThrow('caller canceled');
      expect(execute).not.toHaveBeenCalled();
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        const token = (await new UserMCPOAuthTokenRepository(db).getToken(f.user, f.server))!;
        expect(token.refresh_status).toBe('idle');
        expect(token.managed_metadata?.next_sequence).toBe('1');
      });
    });
    it('a paused refresh adapter retains the live grant when its fresh claim never invoked the sender', async () => {
      const f = await seedManagedRefreshGrant(owned.db, master);
      const request = vi.fn();
      const adapter = createManagedOAuthRefreshAdapter({
        client: { request } as unknown as ManagedMCPOAuthClient,
        issuer: 'https://broker.example.test/',
        keys: new Map(),
        now: () => Date.now(),
        assertCurrent: () => {
          throw new Error('synthetic refresh paused');
        },
        acknowledge: async () => {},
      });
      await expect(refreshAndPersistToken(deps(f, adapter))).rejects.toThrow('refresh admission');
      expect(request).not.toHaveBeenCalled();
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        const repo = new UserMCPOAuthTokenRepository(db);
        const token = (await repo.getToken(f.user, f.server))!;
        expect(token.refresh_status).toBe('idle');
        expect(token.managed_operation_id).toBeUndefined();
        expect(token.managed_metadata).toEqual(f.commit.metadata);
        expect(token.oauth_access_token).toBe(f.commit.tokens.access_token);
        expect(await new MCPManagedOAuthOutboxRepository(db).listPending(f.tenant)).toEqual([]);
      });
    });
    it('paused receipt recovery cannot claim a previous owner did not dispatch', async () => {
      const f = await seedManagedRefreshGrant(owned.db, master);
      await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        new UserMCPOAuthTokenRepository(db).claimRefresh(f.user, f.server, f.expected)
      );
      const request = vi.fn();
      const adapter = createManagedOAuthRefreshAdapter({
        client: { request } as unknown as ManagedMCPOAuthClient,
        issuer: 'https://broker.example.test/',
        keys: new Map(),
        now: () => Date.now(),
        assertCurrent: () => {
          throw new Error('synthetic refresh paused');
        },
        acknowledge: async () => {},
      });
      await expect(refreshAndPersistToken(deps(f, adapter))).rejects.toBeInstanceOf(
        ManagedRefreshInProgressError
      );
      expect(request).not.toHaveBeenCalled();
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        expect(
          (await new UserMCPOAuthTokenRepository(db).getToken(f.user, f.server))?.refresh_status
        ).toBe('refreshing');
        expect(await new MCPManagedOAuthOutboxRepository(db).listPending(f.tenant)).toEqual([]);
      });
    });
    it('a pause after invoking the sender never becomes a local no-dispatch certificate', async () => {
      const f = await seedManagedRefreshGrant(owned.db, master);
      let paused = false;
      const request = vi.fn(async () => {
        paused = true;
        throw new Error('synthetic uncertain HTTP');
      });
      const adapter = createManagedOAuthRefreshAdapter({
        client: { request } as unknown as ManagedMCPOAuthClient,
        issuer: 'https://broker.example.test/',
        keys: new Map(),
        now: () => Date.now(),
        assertCurrent: () => {
          if (paused) throw new Error('synthetic refresh paused');
        },
        acknowledge: async () => {},
      });
      await expect(refreshAndPersistToken(deps(f, adapter))).rejects.toBeInstanceOf(
        ManagedRefreshInProgressError
      );
      expect(request).toHaveBeenCalledTimes(1);
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        expect(
          (await new UserMCPOAuthTokenRepository(db).getToken(f.user, f.server))?.refresh_status
        ).toBe('refreshing');
        expect(await new MCPManagedOAuthOutboxRepository(db).listPending(f.tenant)).toEqual([]);
      });
    });
  }
);
