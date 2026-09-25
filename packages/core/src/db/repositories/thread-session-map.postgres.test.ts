/**
 * The once-per-conversation claim, under real concurrency.
 *
 * The SQLite suite pins the compare-and-set semantics but cannot overlap two
 * transactions on one in-memory connection. Contention is the whole reason
 * `claimMetadataFlag` exists rather than a read-then-write: two daemons
 * projecting the same Slack thread must not both decide they are the first to
 * warn it.
 *
 * Proved by holding the row from a second connection rather than by racing two
 * calls, because a race that happens to serialize proves nothing — verified by
 * removing `lockRowForUpdate` from the repository, which makes the first test
 * below fail and leaves the second green. See
 * `docs/internal/slack-mcp-oauth-connect-2026-09-16.md`.
 */

import type { BranchID, SessionID, ThreadSessionMapID, UUID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import { createDatabase, type Database } from '../client';
import { lockRowForUpdate, runDatabaseTransaction, update } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import { threadSessionMap } from '../schema';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { BranchRepository } from './branches';
import { GatewayChannelRepository } from './gateway-channels';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { ThreadSessionMapRepository } from './thread-session-map';
import { UsersRepository } from './users';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const describePostgres =
  postgresUrl && process.env.AGOR_DB_DIALECT === 'postgresql' ? describe : describe.skip;

const WARNED_KEY = 'mcp_connect_shared_thread_warned_at';

describePostgres('ThreadSessionMapRepository.claimMetadataFlag (PostgreSQL)', () => {
  let db: Database;
  beforeAll(async () => {
    db = createDatabase({ url: postgresUrl!, dialect: 'postgresql' });
    await initializeDatabase(db);
  });

  async function seedMapping(): Promise<ThreadSessionMapID> {
    return runWithTenantDatabaseScope(db, 'default', async (scoped) => {
      // PostgreSQL enforces that a branch's primary owner is a real user in
      // this tenant, so the fixture cannot invent one.
      const owner = await new UsersRepository(scoped).create({
        email: `thread-map-owner-${generateId()}@example.invalid`,
        role: 'member',
      });
      const repo = await new RepoRepository(scoped).create({
        repo_id: generateId() as UUID,
        slug: `thread-map/${generateId()}`,
        name: 'Thread map test repo',
        repo_type: 'remote' as const,
        remote_url: 'https://github.com/test/thread-map.git',
        local_path: '/tmp/thread-map-test-repo',
        default_branch: 'main',
      });
      const branch = await new BranchRepository(scoped).create({
        branch_id: generateId() as BranchID,
        repo_id: repo.repo_id as UUID,
        name: 'main',
        ref: 'refs/heads/main',
        branch_unique_id: 1,
        path: '/tmp/thread-map-test-repo/main',
        created_by: owner.user_id as UUID,
      });
      const session = await new SessionRepository(scoped).create({
        session_id: generateId() as SessionID,
        branch_id: branch.branch_id as BranchID,
        created_by: owner.user_id as UUID,
        status: SessionStatus.IDLE,
        title: 'Slack thread',
        tasks: [],
      });
      const channel = await new GatewayChannelRepository(scoped).create({
        name: `Slack ${generateId()}`,
        created_by: owner.user_id as UUID,
        target_branch_id: branch.branch_id as UUID,
        channel_type: 'slack',
        enabled: true,
        config: {
          bot_token: 'xoxb-test',
          app_token: 'xapp-test',
          align_slack_users: true,
          allowed_channel_ids: ['C123'],
        },
      });
      const mapping = await new ThreadSessionMapRepository(scoped).create({
        channel_id: channel.id,
        thread_id: 'C123-1700000000.000001',
        session_id: session.session_id,
        branch_id: branch.branch_id,
      });
      return mapping.id;
    });
  }

  function claim(mappingId: ThreadSessionMapID, value: string): Promise<boolean> {
    return runWithTenantDatabaseScope(db, 'default', (scoped) =>
      new ThreadSessionMapRepository(scoped).claimMetadataFlag(mappingId, WARNED_KEY, value)
    );
  }

  function readFlag(mappingId: ThreadSessionMapID): Promise<unknown> {
    return runWithTenantDatabaseScope(db, 'default', async (scoped) => {
      const row = await new ThreadSessionMapRepository(scoped).findById(mappingId);
      return row?.metadata?.[WARNED_KEY];
    });
  }

  it('waits for a competing writer and then refuses the claim it already made', async () => {
    const mappingId = await seedMapping();

    // A peer that is mid-claim, held open deliberately. This is the window a
    // plain read-then-write has no answer for: its SELECT would run against a
    // snapshot taken before the peer committed, see no flag, and warn the
    // thread a second time. Asserting it through a held lock is deterministic,
    // where racing two calls and hoping they overlap is not.
    let releasePeer: (() => void) | undefined;
    const peerHolding = new Promise<void>((resolve) => {
      releasePeer = resolve;
    });
    let peerLocked: (() => void) | undefined;
    const peerHasLock = new Promise<void>((resolve) => {
      peerLocked = resolve;
    });

    const peer = runWithTenantDatabaseScope(db, 'default', (scoped) =>
      runDatabaseTransaction(scoped, async (tx) => {
        await lockRowForUpdate(tx, scoped, threadSessionMap, eq(threadSessionMap.id, mappingId));
        peerLocked?.();
        await peerHolding;
        await update(tx, threadSessionMap)
          .set({ metadata: { [WARNED_KEY]: 'peer' } })
          .where(eq(threadSessionMap.id, mappingId))
          .run();
      })
    );
    await peerHasLock;

    const contender = claim(mappingId, 'contender');
    const settledEarly = await Promise.race([
      contender.then(() => 'settled' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 500)),
    ]);
    // It must not have answered from a snapshot read taken before the peer's
    // write — the claim is still waiting on the row.
    expect(settledEarly).toBe('blocked');

    releasePeer?.();
    await peer;

    await expect(contender).resolves.toBe(false);
    expect(await readFlag(mappingId)).toBe('peer');
  });

  it('grants the claim once when nothing else holds the row', async () => {
    const mappingId = await seedMapping();
    await expect(claim(mappingId, 'first')).resolves.toBe(true);
    await expect(claim(mappingId, 'second')).resolves.toBe(false);
    expect(await readFlag(mappingId)).toBe('first');
  });
});
