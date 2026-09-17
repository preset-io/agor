/**
 * The once-per-conversation claim, under real concurrency.
 *
 * The SQLite suite pins the compare-and-set semantics but cannot overlap two
 * transactions on one in-memory connection. PostgreSQL can, and concurrency is
 * the whole reason `claimMetadataFlag` exists rather than a read-then-write:
 * two daemons projecting the same Slack thread must not both decide they are
 * the first to warn it. See `docs/internal/slack-mcp-oauth-connect-2026-09-16.md`.
 */

import type { BranchID, SessionID, UUID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import { createDatabase, type Database } from '../client';
import { initializeDatabase } from '../migrate';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { BranchRepository } from './branches';
import { GatewayChannelRepository } from './gateway-channels';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { ThreadSessionMapRepository } from './thread-session-map';

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

  it('gives the claim to exactly one of two overlapping callers', async () => {
    const mappingId = await runWithTenantDatabaseScope(db, 'default', async (scoped) => {
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
        created_by: generateId() as UUID,
      });
      const session = await new SessionRepository(scoped).create({
        session_id: generateId() as SessionID,
        branch_id: branch.branch_id as BranchID,
        created_by: generateId() as UUID,
        status: SessionStatus.IDLE,
        title: 'Slack thread',
        tasks: [],
      });
      const channel = await new GatewayChannelRepository(scoped).create({
        name: `Slack ${generateId()}`,
        created_by: generateId() as UUID,
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

    // Two independent connections, started together: the row lock inside the
    // claim is the only thing serializing them.
    const claim = (value: string) =>
      runWithTenantDatabaseScope(db, 'default', (scoped) =>
        new ThreadSessionMapRepository(scoped).claimMetadataFlag(mappingId, WARNED_KEY, value)
      );
    const outcomes = await Promise.all([claim('first'), claim('second')]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const stored = await runWithTenantDatabaseScope(db, 'default', (scoped) =>
      new ThreadSessionMapRepository(scoped).findById(mappingId)
    );
    expect(stored?.metadata?.[WARNED_KEY]).toBe(outcomes[0] ? 'first' : 'second');
  });
});
