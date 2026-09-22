import {
  acquireTenantWriteGate,
  BranchRepository,
  branches,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  enqueueAfterTenantDatabaseCommit,
  eq,
  executeRaw,
  generateId,
  initializeDatabase,
  lockRowForUpdate,
  RepoRepository,
  rawRows,
  releaseTenantWriteGate,
  runWithoutTenantDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  SessionRepository,
  sessions,
  sql,
  TaskRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { Forbidden } from '@agor/core/feathers';
import { TaskStatus } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  lockTenantAuthorizationFence,
  resolveCurrentTenantAuthorityActor,
} from '../services/tenant-authorization-fence.js';
import { resolveSessionPromptAccess } from './branch-authorization.js';
import {
  promptAdmissionSqlState,
  runPromptAdmissionTransaction,
} from './prompt-admission-transaction.js';

const url = process.env.AGOR_TEST_POSTGRES_URL;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'prompt admission PostgreSQL/RLS',
  () => {
    let a: Database;
    let b: Database;
    let observer: Database;
    let db: TenantScopeAwareDatabase;
    let branchUnique = 1;
    beforeAll(async () => {
      a = createDatabase({ dialect: 'postgresql', url: url!, pool: { max: 1 } });
      b = createDatabase({ dialect: 'postgresql', url: url!, pool: { max: 1 } });
      observer = createDatabase({ dialect: 'postgresql', url: url!, pool: { max: 1 } });
      await initializeDatabase(a);
      db = createTenantScopedDatabaseProxy(a);
      expect(
        rawRows(
          await executeRaw(
            a,
            sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
          )
        )
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    }, 60_000);
    afterAll(async () => {
      await Promise.all(
        [a, b, observer].map((client) =>
          (client as Database & { $client: { end(): Promise<void> } }).$client.end()
        )
      );
    });

    async function seed(tenant = `prompt-${generateId()}`) {
      return runWithTenantDatabaseScope(db, tenant, async (tx) => {
        const actor = await new UsersRepository(tx).create({
          email: `${generateId()}@example.invalid`,
          role: 'member',
        });
        const repo = await new RepoRepository(tx).create({
          repo_id: generateId(),
          slug: generateId(),
          name: 'Fixture',
          repo_type: 'remote',
          remote_url: 'https://example.invalid/repo',
          local_path: '/disposable/not-created',
          default_branch: 'main',
        });
        const branch = await new BranchRepository(tx).create({
          branch_id: generateId(),
          repo_id: repo.repo_id,
          name: 'fixture',
          ref: 'main',
          branch_unique_id: branchUnique++,
          path: `/disposable/${generateId()}`,
          created_by: actor.user_id,
        });
        const session = await new SessionRepository(tx).create({
          session_id: generateId(),
          branch_id: branch.branch_id,
          agentic_tool: 'claude-code',
          created_by: actor.user_id,
        });
        const input = {
          session_id: session.session_id,
          full_prompt: 'disposable fixture',
          created_by: actor.user_id,
          status: TaskStatus.QUEUED,
        } as const;
        return { tenant, actor, branch, session, input };
      });
    }

    async function waitForBlocked(pid: number) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const rows = rawRows(
          await executeRaw(observer, sql`SELECT cardinality(pg_blocking_pids(${pid})) AS blockers`)
        );
        if (Number(rows[0]?.blockers) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('fixture did not reach the intended lock wait');
    }

    it('restarts a rolled-back deadlock unit, preserving one enqueue and one post-commit effect', async () => {
      const f = await seed();
      const branchHeld = deferred();
      const letPeerWait = deferred();
      let attempts = 0;
      let effects = 0;
      let pid = 0;
      // Deliberately inject an inverse Session -> Branch holder. This proves
      // recovery, not that such a holder caused the production incident.
      const peer = runWithTenantDatabaseTransaction(b, f.tenant, async (tx) => {
        await lockRowForUpdate(tx, tx, branches, eq(branches.branch_id, f.branch.branch_id));
        branchHeld.resolve();
        await letPeerWait.promise;
        await lockRowForUpdate(tx, tx, sessions, eq(sessions.session_id, f.session.session_id));
      });
      await branchHeld.promise;
      const admission = runPromptAdmissionTransaction(db, f.tenant, async (tx) => {
        attempts++;
        await lockTenantAuthorizationFence(tx);
        await resolveCurrentTenantAuthorityActor(tx, { user: f.actor });
        enqueueAfterTenantDatabaseCommit(() => {
          effects++;
        });
        pid = Number(rawRows(await executeRaw(tx, sql`SELECT pg_backend_pid() AS pid`))[0].pid);
        if (attempts === 1)
          await lockRowForUpdate(tx, tx, sessions, eq(sessions.session_id, f.session.session_id));
        return new TaskRepository(tx).createPending(f.input);
      });
      // Attach handlers before orchestrating the cycle, including failure cleanup.
      const settled = Promise.allSettled([admission, peer]);
      try {
        const deadline = Date.now() + 5_000;
        while (!pid && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 1));
        if (!pid) throw new Error('admission did not start');
        await waitForBlocked(pid);
        letPeerWait.resolve();
        const [admitted, peerResult] = await settled;
        expect(peerResult.status).toBe('fulfilled');
        expect(admitted.status).toBe('fulfilled');
        expect(attempts).toBe(2);
        expect(effects).toBe(1);
        await runWithTenantDatabaseScope(db, f.tenant, async (tx) => {
          const page = await new TaskRepository(tx).findPage({ sessionId: f.session.session_id });
          expect(page.total).toBe(1);
          expect(page.data[0]).toMatchObject({ status: TaskStatus.QUEUED, queue_position: 1 });
          expect(
            rawRows(
              await executeRaw(
                tx,
                sql`SELECT count(*)::int AS count FROM messages WHERE session_id = ${f.session.session_id}`
              )
            )[0].count
          ).toBe(0);
        });
      } finally {
        letPeerWait.resolve();
        await settled;
      }
    }, 15_000);

    it.each([false, true])(
      'real concurrent 40001 at the branch lock (retry enabled: %s)',
      async (retry) => {
        const f = await seed();
        const prewrite = await seed(f.tenant);
        let attempts = 0;
        let effects = 0;
        await executeRaw(
          a,
          sql`SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ`
        );
        try {
          const run = retry ? runPromptAdmissionTransaction : runWithTenantDatabaseTransaction;
          const result = await run(db, f.tenant, async (tx) => {
            attempts++;
            enqueueAfterTenantDatabaseCommit(() => {
              effects++;
            });
            expect(
              rawRows(await executeRaw(tx, sql`SHOW transaction_isolation`))[0]
                .transaction_isolation
            ).toBe('repeatable read');
            // Prove that writes preceding the failed lock roll back as well.
            await new TaskRepository(tx).createPending(prewrite.input);
            // Establish the snapshot before a separate connection updates Branch.
            await executeRaw(
              tx,
              sql`SELECT branch_id FROM branches WHERE branch_id = ${f.branch.branch_id}`
            );
            if (attempts === 1) {
              await runWithoutTenantDatabaseScope(() =>
                runWithTenantDatabaseScope(b, f.tenant, (peer) =>
                  new BranchRepository(peer).update(f.branch.branch_id, {
                    name: 'concurrently updated',
                  })
                )
              );
            }
            return new TaskRepository(tx).createPending(f.input);
          }).then(
            (task) => ({ task, error: undefined }),
            (error: unknown) => ({ task: undefined, error })
          );
          expect(attempts).toBe(retry ? 2 : 1);
          expect(effects).toBe(retry ? 1 : 0);
          if (retry) expect(result.task?.queue_position).toBe(1);
          else expect(promptAdmissionSqlState(result.error)).toBe('40001');
          await runWithTenantDatabaseScope(db, f.tenant, async (tx) => {
            expect(
              (await new TaskRepository(tx).findPage({ sessionId: f.session.session_id })).total
            ).toBe(retry ? 1 : 0);
            expect(
              (await new TaskRepository(tx).findPage({ sessionId: prewrite.session.session_id }))
                .total
            ).toBe(retry ? 1 : 0);
          });
        } finally {
          await executeRaw(
            a,
            sql`SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED`
          );
        }
      }
    );

    it('never replays admission after a committed task and a failing post-commit effect', async () => {
      const f = await seed();
      let attempts = 0;
      await expect(
        runPromptAdmissionTransaction(db, f.tenant, async (tx) => {
          attempts++;
          const task = await new TaskRepository(tx).createPending(f.input);
          enqueueAfterTenantDatabaseCommit(async () => {
            throw Object.assign(new Error('post-commit failure'), { code: '40001' });
          });
          return task;
        })
      ).rejects.toThrow('Could not confirm');
      expect(attempts).toBe(1);
      await runWithTenantDatabaseScope(db, f.tenant, async (tx) => {
        expect(
          (await new TaskRepository(tx).findPage({ sessionId: f.session.session_id })).total
        ).toBe(1);
      });
    });

    it.each(['lock_timeout', 'statement_timeout'] as const)(
      'does not replay %s; rollback frees the connection for a later explicit admission',
      async (timeout) => {
        const f = await seed();
        const held = deferred();
        const release = deferred();
        const peer = runWithTenantDatabaseTransaction(b, f.tenant, async (tx) => {
          await lockRowForUpdate(tx, tx, branches, eq(branches.branch_id, f.branch.branch_id));
          held.resolve();
          await release.promise;
        });
        await held.promise;
        let attempts = 0;
        try {
          const error = await runPromptAdmissionTransaction(db, f.tenant, async (tx) => {
            attempts++;
            await executeRaw(tx, sql`SELECT set_config(${timeout}, '100ms', true)`);
            return new TaskRepository(tx).createPending(f.input);
          }).catch((error: unknown) => error);
          expect(promptAdmissionSqlState(error)).toBe(
            timeout === 'lock_timeout' ? '55P03' : '57014'
          );
          expect(attempts).toBe(1);
          expect(JSON.stringify(error)).not.toContain(f.branch.branch_id);
        } finally {
          release.resolve();
          await peer;
        }
        await expect(
          runPromptAdmissionTransaction(db, f.tenant, (tx) =>
            new TaskRepository(tx).createPending(f.input)
          )
        ).resolves.toMatchObject({ queue_position: 1 });
      }
    );

    it('keeps same-tenant prompt authorization inside admission and does not retry denial', async () => {
      const f = await seed();
      const outsider = await runWithTenantDatabaseScope(db, f.tenant, (tx) =>
        new UsersRepository(tx).create({ email: `${generateId()}@example.invalid`, role: 'member' })
      );
      let attempts = 0;
      await expect(
        runPromptAdmissionTransaction(db, f.tenant, async (tx) => {
          attempts++;
          await lockTenantAuthorizationFence(tx);
          await resolveCurrentTenantAuthorityActor(tx, { user: outsider });
          const access = await resolveSessionPromptAccess({
            branchRepository: new BranchRepository(tx),
            branch: f.branch,
            session: f.session,
            userId: outsider.user_id,
          });
          if (!access.allowed) throw new Forbidden('Prompt not authorized');
          return new TaskRepository(tx).createPending({ ...f.input, created_by: outsider.user_id });
        })
      ).rejects.toThrow(Forbidden);
      expect(attempts).toBe(1);
      await runWithTenantDatabaseScope(db, f.tenant, async (tx) => {
        expect(
          (await new TaskRepository(tx).findPage({ sessionId: f.session.session_id })).total
        ).toBe(0);
      });
    });

    it('retains maintenance, tenant identity and RLS denials without retry', async () => {
      const f = await seed();
      let attempts = 0;
      await expect(
        runPromptAdmissionTransaction(db, `foreign-${generateId()}`, (tx) => {
          attempts++;
          return new TaskRepository(tx).createPending(f.input);
        })
      ).rejects.toThrow('not found');
      expect(attempts).toBe(1);
      await expect(
        runWithTenantContext('other-tenant', () =>
          runPromptAdmissionTransaction(db, f.tenant, (tx) =>
            new TaskRepository(tx).createPending(f.input)
          )
        )
      ).rejects.toThrow('active tenant context');
      const gate = await acquireTenantWriteGate(a, f.tenant, { reason: 'fixture freeze' });
      try {
        await expect(
          runPromptAdmissionTransaction(db, f.tenant, (tx) =>
            new TaskRepository(tx).createPending(f.input)
          )
        ).rejects.toThrow();
      } finally {
        await releaseTenantWriteGate(a, f.tenant, { generation: gate.generation });
      }
      await runWithTenantDatabaseScope(db, f.tenant, (tx) =>
        executeRaw(
          tx,
          sql`UPDATE branches SET deletion_status = 'deleting' WHERE branch_id = ${f.branch.branch_id}`
        )
      );
      await expect(
        runPromptAdmissionTransaction(db, f.tenant, (tx) =>
          new TaskRepository(tx).createPending(f.input)
        )
      ).rejects.toThrow('Branch deletion');
    });
  }
);
