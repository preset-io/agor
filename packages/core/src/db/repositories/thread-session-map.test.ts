/**
 * ThreadSessionMapRepository — the once-per-conversation claim.
 *
 * `claimMetadataFlag` is what makes a notice appear once per (session,
 * conversation) rather than once per event, and the only caller today is the
 * MCP connect lane's shared-thread warning. Every test above it mocks the
 * method away, which pins that the gateway calls it and says nothing about
 * whether it actually compares and sets. That is the failure shape
 * `docs/internal/slack-mcp-oauth-connect-2026-09-16.md` §8 describes, so this
 * suite drives the real method over real rows.
 */

import type { BranchID, SessionID, UUID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { ownedDbTest as dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { GatewayChannelRepository } from './gateway-channels';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { ThreadSessionMapRepository } from './thread-session-map';

const WARNED_KEY = 'mcp_connect_shared_thread_warned_at';

async function seedMapping(db: Database, metadata: Record<string, unknown> = {}) {
  const repo = await new RepoRepository(db).create({
    repo_id: generateId() as UUID,
    slug: `thread-map/${generateId()}`,
    name: 'Thread map test repo',
    repo_type: 'remote' as const,
    remote_url: 'https://github.com/test/thread-map.git',
    local_path: '/tmp/thread-map-test-repo',
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id as UUID,
    name: 'main',
    ref: 'refs/heads/main',
    branch_unique_id: 1,
    path: '/tmp/thread-map-test-repo/main',
    created_by: 'test-user' as UUID,
  });
  const session = await new SessionRepository(db).create({
    session_id: generateId() as SessionID,
    branch_id: branch.branch_id as BranchID,
    created_by: generateId() as UUID,
    status: SessionStatus.IDLE,
    title: 'Slack thread',
    tasks: [],
  });
  const channel = await new GatewayChannelRepository(db).create({
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
  const mappings = new ThreadSessionMapRepository(db);
  const mapping = await mappings.create({
    channel_id: channel.id,
    thread_id: 'C123-1700000000.000001',
    session_id: session.session_id,
    branch_id: branch.branch_id,
    metadata,
  });
  return { mappings, mapping, session };
}

describe('ThreadSessionMapRepository.claimMetadataFlag', () => {
  dbTest('grants the claim once and records the value', async ({ db }) => {
    const { mappings, mapping } = await seedMapping(db);

    await expect(
      mappings.claimMetadataFlag(mapping.id, WARNED_KEY, '2026-09-17T10:00:00.000Z')
    ).resolves.toBe(true);
    expect((await mappings.findById(mapping.id))?.metadata?.[WARNED_KEY]).toBe(
      '2026-09-17T10:00:00.000Z'
    );

    // A second connect in the same thread must not warn again, and must not
    // overwrite when the first claim landed.
    await expect(
      mappings.claimMetadataFlag(mapping.id, WARNED_KEY, '2026-09-17T11:00:00.000Z')
    ).resolves.toBe(false);
    expect((await mappings.findById(mapping.id))?.metadata?.[WARNED_KEY]).toBe(
      '2026-09-17T10:00:00.000Z'
    );
  });

  dbTest('claims per conversation, not per channel', async ({ db }) => {
    // §4.8 asks for the notice once per (session, conversation). The flag
    // therefore lives on the thread mapping — a second thread in the same
    // channel is a different conversation and gets its own warning.
    const first = await seedMapping(db);
    const second = await seedMapping(db);

    await expect(first.mappings.claimMetadataFlag(first.mapping.id, WARNED_KEY, 'a')).resolves.toBe(
      true
    );
    await expect(
      second.mappings.claimMetadataFlag(second.mapping.id, WARNED_KEY, 'b')
    ).resolves.toBe(true);
    expect((await first.mappings.findById(first.mapping.id))?.metadata?.[WARNED_KEY]).toBe('a');
  });

  dbTest('does not decide the claim from a snapshot read before it', async ({ db }) => {
    const { mappings, mapping } = await seedMapping(db);

    // The shape a plain read-then-write would get wrong: both callers read the
    // same unwarned snapshot, and both then write. The claim re-reads under
    // the row lock, so the second caller is refused even though its snapshot
    // said the flag was unset. True concurrency is asserted in the PostgreSQL
    // lane, where two connections can actually overlap.
    const stale = await mappings.findById(mapping.id);
    expect(stale?.metadata?.[WARNED_KEY]).toBeUndefined();

    await expect(mappings.claimMetadataFlag(mapping.id, WARNED_KEY, 'winner')).resolves.toBe(true);
    await expect(mappings.claimMetadataFlag(mapping.id, WARNED_KEY, 'loser')).resolves.toBe(false);
    expect((await mappings.findById(mapping.id))?.metadata?.[WARNED_KEY]).toBe('winner');
  });

  dbTest('treats a null-valued key as unclaimed and keeps other metadata', async ({ db }) => {
    const { mappings, mapping } = await seedMapping(db, {
      [WARNED_KEY]: null,
      seeded_by: 'gateway',
    });

    await expect(mappings.claimMetadataFlag(mapping.id, WARNED_KEY, 'now')).resolves.toBe(true);
    const metadata = (await mappings.findById(mapping.id))?.metadata;
    expect(metadata?.[WARNED_KEY]).toBe('now');
    expect(metadata?.seeded_by).toBe('gateway');
  });

  dbTest('refuses a mapping that does not exist', async ({ db }) => {
    const { mappings } = await seedMapping(db);
    await expect(
      mappings.claimMetadataFlag(generateId() as never, WARNED_KEY, 'now')
    ).rejects.toThrow(/ThreadSessionMap/);
  });
});
