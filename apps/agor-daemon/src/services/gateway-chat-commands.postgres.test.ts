/** Independent connections prove the command receipt and Session fence survive HA. */
import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  executeRaw,
  GatewayChannelRepository,
  GatewayChatCommandRepository,
  GatewayInboundEventRepository,
  generateId,
  initializeDatabase,
  runWithTenantDatabaseScope,
  sql,
  TaskRepository,
  ThreadSessionMapRepository,
} from '@agor/core/db';
import { TaskStatus } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gatewayCommandFixture } from '../../test/gateway-command-fixture.js';
import { lockTenantAuthorizationFence } from './tenant-authorization-fence.js';

const url = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'gateway commands PostgreSQL/HA',
  () => {
    let a: Database;
    let b: Database;
    beforeAll(async () => {
      a = createDatabase({ dialect: 'postgresql', url: url! });
      b = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(a);
      const result = await executeRaw(
        a,
        sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      );
      const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
      expect(rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
    }, 60000);
    afterAll(async () => {
      await Promise.all(
        [a, b].map((db) => (db as Database & { $client: { end(): Promise<void> } }).$client.end())
      );
    });
    const scoped = <T>(db: Database, tenant: string, work: (db: Database) => Promise<T>) =>
      runWithTenantDatabaseScope(
        createTenantScopedDatabaseProxy(db, { requireScope: true }),
        tenant,
        work
      );

    async function fixture(tenant: string) {
      return scoped(a, tenant, async (db) => {
        const f = await gatewayCommandFixture(db);
        const token = generateId();
        const listener = await new GatewayChannelRepository(db).claimListener({
          channelId: f.channel.id,
          claimToken: token,
          leaseDurationMs: 60_000,
          instanceId: 'test',
          bootId: 'test',
        });
        expect(listener.outcome).toBe('claimed');
        const claim = await new GatewayInboundEventRepository(db).claim({
          channelId: f.channel.id,
          providerEventId: generateId(),
          threadId: f.input.threadId,
          processingToken: token,
          leaseDurationMs: 60_000,
          requireListenerClaim: true,
        });
        if (claim.outcome !== 'claimed') throw new Error('Missing event claim');
        return { ...f, input: { ...f.input, event: claim.event, listenerToken: token } };
      });
    }

    it('two daemons apply one command once; later queued work survives a replay', async () => {
      const tenant = `command-${generateId()}`;
      const f = await fixture(tenant);
      const apply = (db: Database) =>
        scoped(db, tenant, async (tx) => {
          await lockTenantAuthorizationFence(tx);
          return new GatewayChatCommandRepository(tx).execute(f.input);
        });
      const results = await Promise.all([apply(a), apply(b)]);
      expect(results[0].receipt).toEqual(results[1].receipt);
      expect(results.flatMap((r) => r.removed)).toHaveLength(3);
      await scoped(b, tenant, async (tx) => {
        const task = await new TaskRepository(tx).createPending({
          session_id: f.input.sessionId,
          created_by: f.input.userId,
          full_prompt: 'new work',
          status: TaskStatus.QUEUED,
        });
        expect(task.status).toBe(TaskStatus.QUEUED);
      });
      expect((await apply(b)).removed).toEqual([]);
      await scoped(a, tenant, async (tx) => {
        expect(await new TaskRepository(tx).findQueued(f.input.sessionId)).toHaveLength(1);
        expect((await new TaskRepository(tx).findById(f.seed.active.task_id))?.status).toBe(
          TaskStatus.STOPPING
        );
      });
    });

    it('a no-session receipt survives replay on another daemon after a mapping appears', async () => {
      const tenant = `command-unmapped-${generateId()}`;
      const f = await fixture(tenant);
      const first = await scoped(a, tenant, async (tx) => {
        await lockTenantAuthorizationFence(tx);
        return new GatewayChatCommandRepository(tx).execute({
          ...f.input,
          sessionId: null,
          expected: null,
        });
      });
      expect(first.receipt).toMatchObject({ outcome: 'idle', session_id: null });
      await scoped(b, tenant, async (tx) => {
        await lockTenantAuthorizationFence(tx);
        const replay = await new GatewayChatCommandRepository(tx).execute(f.input);
        expect(replay.receipt).toEqual(first.receipt);
        expect(replay.removed).toEqual([]);
        expect(replay.claimed).toBeNull();
        expect(await new TaskRepository(tx).findQueued(f.input.sessionId)).toHaveLength(3);
        expect((await new TaskRepository(tx).findById(f.seed.active.task_id))?.status).toBe(
          TaskStatus.RUNNING
        );
      });
    });

    it('resolves identical provider threads independently under tenant RLS', async () => {
      const tenantA = `implicit-a-${generateId()}`;
      const tenantB = `implicit-b-${generateId()}`;
      const first = await fixture(tenantA);
      const second = await fixture(tenantB);
      for (const [tenant, f] of [
        [tenantA, first],
        [tenantB, second],
      ] as const) {
        await scoped(a, tenant, async (tx) => {
          await new ThreadSessionMapRepository(tx).create({
            channel_id: f.channel.id,
            thread_id: f.input.threadId,
            session_id: f.input.sessionId,
            branch_id: f.seed.branch.branch_id,
          });
        });
      }
      await scoped(b, tenantB, async (tx) => {
        const commands = new GatewayChatCommandRepository(tx);
        expect(
          await commands.resolveImplicitTarget(second.channel.id, [second.input.threadId])
        ).toEqual({ outcome: 'selected', sessionId: second.input.sessionId });
        expect(
          await commands.resolveImplicitTarget(first.channel.id, [first.input.threadId])
        ).toEqual({ outcome: 'not_target', sessionId: null });
        await lockTenantAuthorizationFence(tx);
        expect(
          (await commands.execute({ ...second.input, implicitThreadIds: [second.input.threadId] }))
            .receipt.outcome
        ).toBe('requested');
      });
      await scoped(a, tenantA, async (tx) => {
        expect((await new TaskRepository(tx).findById(first.seed.active.task_id))?.status).toBe(
          TaskStatus.RUNNING
        );
      });
    });

    it('rejects another tenant targeting the same session or provider occurrence', async () => {
      const tenantA = `command-a-${generateId()}`;
      const tenantB = `command-b-${generateId()}`;
      const f = await fixture(tenantA);
      const other = await fixture(tenantB);
      await scoped(b, tenantB, async (tx) => {
        await lockTenantAuthorizationFence(tx);
        const commands = new GatewayChatCommandRepository(tx);
        expect(
          (await commands.execute({ ...f.input, userId: other.input.userId })).receipt.outcome
        ).toBe('denied');
      });
      await expect(
        scoped(b, tenantB, async (tx) => {
          await lockTenantAuthorizationFence(tx);
          return new GatewayChatCommandRepository(tx).execute({
            ...other.input,
            event: { ...other.input.event, id: f.input.event.id },
            listenerToken: other.input.listenerToken,
          });
        })
      ).rejects.toThrow();
      await scoped(a, tenantA, async (tx) => {
        expect(await new TaskRepository(tx).findQueued(f.input.sessionId)).toHaveLength(3);
        expect((await new TaskRepository(tx).findById(f.seed.active.task_id))?.status).toBe(
          TaskStatus.RUNNING
        );
      });
    });
  }
);
