/**
 * PostgreSQL integration proof for Session Task queue admission and dispatch.
 *
 * Run with:
 *   AGOR_DB_DIALECT=postgresql \
 *   AGOR_TEST_POSTGRES_URL=postgresql://user:pw@host:5432/db \
 *   pnpm --filter @agor/core exec vitest run src/db/task-queue-ha.postgres.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import type { MessageID, SessionID, TaskID, UUID } from '../types/id';
import { MessageRole } from '../types/message';
import { TaskStatus } from '../types/task';
import { createDatabase, type Database } from './client';
import { isPostgresDatabase } from './database-wrapper';
import { initializeDatabase } from './migrate';
import {
  BranchRepository,
  MessagesRepository,
  RepoRepository,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from './repositories';
import { runWithSystemDatabaseScope, runWithTenantDatabaseScope } from './tenant-scope';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
let branchUnique = Date.now() % 1_000_000;

interface TenantSeed {
  tenantId: string;
  userId: UUID;
  branchId: UUID;
}

async function seedTenant(db: Database, tenantId: string): Promise<TenantSeed> {
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const user = await new UsersRepository(scoped).create({
      email: `${tenantId}-${generateId()}@example.com`,
      name: `Queue ${tenantId}`,
    });
    const repo = await new RepoRepository(scoped).create({
      repo_id: generateId(),
      slug: `task-queue-ha-${tenantId}-${generateId()}`,
      name: `Task queue HA ${tenantId}`,
      repo_type: 'remote',
      remote_url: 'https://example.invalid/task-queue-ha.git',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(scoped).create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: `task-queue-ha-${tenantId}`,
      ref: 'main',
      branch_unique_id: branchUnique++,
      path: `/tmp/${generateId()}`,
      created_by: user.user_id,
    });
    return {
      tenantId,
      userId: user.user_id as UUID,
      branchId: branch.branch_id as UUID,
    };
  });
}

async function createSession(db: Database, seed: TenantSeed): Promise<SessionID> {
  return runWithTenantDatabaseScope(db, seed.tenantId, async (scoped) => {
    const session = await new SessionRepository(scoped).create({
      session_id: generateId() as SessionID,
      branch_id: seed.branchId,
      created_by: seed.userId,
      agentic_tool: 'claude-code',
    });
    return session.session_id;
  });
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)('Session Task queue HA (PostgreSQL)', () => {
  let db: Database;

  beforeAll(async () => {
    db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    await initializeDatabase(db);
    if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');
  });

  afterAll(async () => {
    await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
  });

  it('serializes two daemon prompt admissions on one idle Session', async () => {
    const seed = await seedTenant(db, `queue-prompt-race-${generateId()}`);
    const sessionId = await createSession(db, seed);

    const admissions = await Promise.all(
      ['first prompt', 'second prompt'].map((fullPrompt) =>
        runWithTenantDatabaseScope(db, seed.tenantId, async (scoped) => {
          // Each scope represents one daemon request/transaction.
          const tasks = new TaskRepository(scoped);
          const task = await tasks.createPending({
            session_id: sessionId,
            created_by: seed.userId,
            full_prompt: fullPrompt,
            status: TaskStatus.QUEUED,
          });
          return tasks.claimDispatchAndProjectSession(task.task_id, TaskStatus.QUEUED, {
            status: TaskStatus.DISPATCHING,
          });
        })
      )
    );

    expect(admissions.filter((admission) => admission.outcome === 'claimed')).toHaveLength(1);
    expect(
      admissions.filter((admission) => admission.task.status === TaskStatus.QUEUED)
    ).toHaveLength(1);
    await runWithTenantDatabaseScope(db, seed.tenantId, async (scoped) => {
      const tasks = await new TaskRepository(scoped).findBySession(sessionId);
      expect(tasks.map((task) => task.queue_position).filter(Boolean)).toEqual([1]);
      expect(tasks.filter((task) => task.status === TaskStatus.DISPATCHING)).toHaveLength(1);
      expect((await new SessionRepository(scoped).findById(sessionId))?.tasks).toHaveLength(1);
    });
  });

  it('lets one of five drainers claim and launch one queued Task', async () => {
    const seed = await seedTenant(db, `queue-five-drainers-${generateId()}`);
    const sessionId = await createSession(db, seed);
    const task = await runWithTenantDatabaseScope(db, seed.tenantId, (scoped) =>
      new TaskRepository(scoped).createPending({
        session_id: sessionId,
        created_by: seed.userId,
        full_prompt: 'launch once',
        status: TaskStatus.QUEUED,
      })
    );
    let launches = 0;

    const claims = await Promise.all(
      Array.from({ length: 5 }, () =>
        runWithTenantDatabaseScope(db, seed.tenantId, async (scoped) => {
          const claim = await new TaskRepository(scoped).claimDispatchAndProjectSession(
            task.task_id,
            TaskStatus.QUEUED,
            { status: TaskStatus.DISPATCHING }
          );
          // Mirrors spawnTaskExecutor's side-effect fence: only a claimant may
          // hand work to an executor.
          if (claim.outcome === 'claimed') launches += 1;
          return claim;
        })
      )
    );

    expect(claims.filter((claim) => claim.outcome === 'claimed')).toHaveLength(1);
    expect(claims.filter((claim) => claim.outcome === 'already_claimed')).toHaveLength(4);
    expect(launches).toBe(1);
  });

  it('keeps deterministic callback admission idempotent across replicas and lets a peer claim it', async () => {
    const seed = await seedTenant(db, `queue-callback-replica-${generateId()}`);
    const sessionId = await createSession(db, seed);
    const callbackTaskId = generateId() as TaskID;
    const callbackInput = {
      task_id: callbackTaskId,
      session_id: sessionId,
      created_by: seed.userId,
      full_prompt: '[Agor] Child session completed',
      status: TaskStatus.QUEUED,
      metadata: {
        is_agor_callback: true,
        source: 'agor' as const,
        queued_by_user_id: seed.userId,
        initial_message_id: callbackTaskId as MessageID,
      },
    };

    // Separate repositories/scopes model two daemons whose local callback
    // coalescer Maps cannot see each other. The stable Task identity and
    // Session-row serialization are the durable authority.
    const admissions = await Promise.all(
      Array.from({ length: 2 }, () =>
        runWithTenantDatabaseScope(db, seed.tenantId, (scoped) =>
          new TaskRepository(scoped).createPending(callbackInput)
        )
      )
    );
    expect(admissions.map((task) => task.task_id)).toEqual([callbackTaskId, callbackTaskId]);

    const claims = await Promise.all(
      Array.from({ length: 2 }, () =>
        runWithTenantDatabaseScope(db, seed.tenantId, (scoped) =>
          new TaskRepository(scoped).claimDispatchAndProjectSession(
            callbackTaskId,
            TaskStatus.QUEUED,
            { status: TaskStatus.DISPATCHING }
          )
        )
      )
    );
    expect(claims.filter((claim) => claim.outcome === 'claimed')).toHaveLength(1);
    expect(claims.filter((claim) => claim.outcome === 'already_claimed')).toHaveLength(1);

    await runWithTenantDatabaseScope(db, seed.tenantId, async (scoped) => {
      const persisted = await new TaskRepository(scoped).findBySession(sessionId);
      expect(persisted.filter((task) => task.task_id === callbackTaskId)).toHaveLength(1);
    });
  });

  it('assigns one unique ordered position under concurrent enqueue', async () => {
    const seed = await seedTenant(db, `queue-order-${generateId()}`);
    const sessionId = await createSession(db, seed);

    const queued = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        runWithTenantDatabaseScope(db, seed.tenantId, (scoped) =>
          new TaskRepository(scoped).createPending({
            session_id: sessionId,
            created_by: seed.userId,
            full_prompt: `prompt ${index}`,
            status: TaskStatus.QUEUED,
          })
        )
      )
    );

    expect(queued.map((task) => task.queue_position).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps discovery routing-only and refuses cross-tenant claim/inference', async () => {
    const a = await seedTenant(db, `queue-tenant-a-${generateId()}`);
    const b = await seedTenant(db, `queue-tenant-b-${generateId()}`);
    const sessionA = await createSession(db, a);
    const sessionB = await createSession(db, b);
    const nonQueuedSessionB = await createSession(db, b);
    const queuedA = await runWithTenantDatabaseScope(db, a.tenantId, (scoped) =>
      new TaskRepository(scoped).createPending({
        session_id: sessionA,
        created_by: a.userId,
        full_prompt: 'tenant A',
        status: TaskStatus.QUEUED,
      })
    );
    const queuedB = await runWithTenantDatabaseScope(db, b.tenantId, (scoped) =>
      new TaskRepository(scoped).createPending({
        session_id: sessionB,
        created_by: b.userId,
        full_prompt: 'tenant B',
        status: TaskStatus.QUEUED,
      })
    );
    const nonQueuedB = await runWithTenantDatabaseScope(db, b.tenantId, (scoped) =>
      new TaskRepository(scoped).createPending({
        task_id: generateId() as TaskID,
        session_id: nonQueuedSessionB,
        created_by: b.userId,
        full_prompt: 'not discoverable',
        status: TaskStatus.CREATED,
      })
    );

    await runWithTenantDatabaseScope(db, a.tenantId, async (scoped) => {
      const tasks = new TaskRepository(scoped);
      expect(await tasks.findById(queuedB.task_id)).toBeNull();
      expect(await tasks.findById(nonQueuedB.task_id)).toBeNull();
      await expect(
        tasks.claimDispatchAndProjectSession(queuedB.task_id, TaskStatus.QUEUED, {
          status: TaskStatus.DISPATCHING,
        })
      ).rejects.toThrow(/not found/);
    });

    const refs = await runWithSystemDatabaseScope(
      db,
      'Task queue HA integration discovery',
      (systemDb) => new TaskRepository(systemDb).findQueuedSessionRefs(100),
      { capability: 'task_queue_discovery' }
    );
    const tenantsBySession = new Map(refs.map((ref) => [ref.session_id, ref.tenant_id]));
    expect(tenantsBySession.get(sessionA)).toBe(a.tenantId);
    expect(tenantsBySession.get(sessionB)).toBe(b.tenantId);
    expect(refs.some((ref) => ref.session_id === nonQueuedB.session_id)).toBe(false);
    expect(queuedA.full_prompt).toBe('tenant A');
    expect(Object.keys(refs[0] ?? {}).sort()).toEqual(
      ['first_queued_at', 'session_id', 'tenant_id'].sort()
    );
  });

  it('elects one widget resolver and hides the claim across tenants', async () => {
    const a = await seedTenant(db, `widget-tenant-a-${generateId()}`);
    const b = await seedTenant(db, `widget-tenant-b-${generateId()}`);
    const sessionB = await createSession(db, b);
    const widgetId = generateId() as MessageID;
    await runWithTenantDatabaseScope(db, b.tenantId, (scoped) =>
      new MessagesRepository(scoped).create({
        message_id: widgetId,
        session_id: sessionB,
        type: 'widget_request',
        role: MessageRole.SYSTEM,
        index: 0,
        timestamp: new Date().toISOString(),
        content_preview: 'Resolve me',
        content: 'Resolve me',
        metadata: {
          widget: {
            widget_id: widgetId,
            widget_type: 'test',
            schema_version: 1,
            params: {},
            status: 'pending',
            requested_at: new Date().toISOString(),
          },
        },
      })
    );

    let externalEffects = 0;
    const claims = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        runWithTenantDatabaseScope(db, b.tenantId, async (scoped) => {
          const result = await new MessagesRepository(scoped).mutateMetadataLocked(
            widgetId,
            (metadata) => {
              const widget = metadata?.widget;
              if (widget?.status !== 'pending') return null;
              return {
                ...metadata,
                widget: {
                  ...widget,
                  status: 'resolving',
                  resolution_claim: {
                    token: `daemon-${index}`,
                    action: index % 2 === 0 ? 'submit' : 'dismiss',
                    claimed_at: new Date().toISOString(),
                    claimed_by: b.userId,
                  },
                },
              };
            }
          );
          // Mirrors WidgetResolutionStore: only the committed claimant may
          // cross into registry/external work.
          if (result.changed) externalEffects += 1;
          return result;
        })
      )
    );
    expect(claims.filter((claim) => claim.changed)).toHaveLength(1);
    expect(externalEffects).toBe(1);

    await runWithTenantDatabaseScope(db, a.tenantId, async (scoped) => {
      expect(await new MessagesRepository(scoped).findById(widgetId)).toBeNull();
      await expect(
        new MessagesRepository(scoped).mutateMetadataLocked(widgetId, () => ({}))
      ).rejects.toThrow(/not found/);
    });
  });
});
