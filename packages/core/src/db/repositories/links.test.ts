import type { Link, UUID } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { generateId } from '../../lib/ids';
import { normalizeRefTargetKey, normalizeUrlTargetKey } from '../../types/link';
import { insert } from '../database-wrapper';
import { type LinkInsert, type LinkRow, links } from '../schema';
import { dbTest } from '../test-helpers';
import { LinksRepository } from './links';

import {
  seedLinkBranch as seedBranch,
  seedLinkMessage as seedMessage,
  seedLinkSession as seedSession,
} from './links.test-helpers';

async function setupLinksRepository(db: Parameters<typeof seedBranch>[0]) {
  const repo = new LinksRepository(db);
  const branch = await seedBranch(db);
  const session = await seedSession(db, branch.branch_id, 'owner' as UUID);
  return { repo, branch, session };
}

describe('LinksRepository', () => {
  dbTest('enforces durable link row structure in the database', async ({ db }) => {
    const branch = await seedBranch(db);
    const session = await seedSession(db, branch.branch_id, 'owner' as UUID);
    const now = new Date();
    const base = {
      branch_id: null,
      session_id: session.session_id,
      source_message_id: null,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com',
      ref_uri: null,
      file_path: null,
      target_object_type: null,
      target_object_id: null,
      target_key: 'url:https://example.com/',
      is_pinned: false,
      title: null,
      mime_type: null,
      metadata: null,
      created_by: null,
      created_at: now,
      updated_at: now,
    } satisfies Omit<LinkInsert, 'link_id'>;
    const expectConstraint = async (
      patch: Partial<LinkInsert>,
      constraint: string
    ): Promise<void> => {
      try {
        await insert(db, links)
          .values({ ...base, ...patch, link_id: generateId() })
          .returning()
          .one();
        expect.fail(`Expected ${constraint} to reject the row`);
      } catch (error) {
        const cause = error instanceof Error ? error.cause : null;
        const details = [error, cause]
          .map((item) => (item instanceof Error ? item.message : String(item ?? '')))
          .join('\n');
        expect(details).toContain(constraint);
      }
    };

    await expectConstraint({ branch_id: branch.branch_id }, 'links_owner_xor_check');
    await expectConstraint({ url: null }, 'links_target_xor_check');
    await expectConstraint({ url: '   ' }, 'links_target_xor_check');
    await expectConstraint({ ref_uri: 'agor://kb/team/runbook.md' }, 'links_target_xor_check');
    await expectConstraint({ target_object_type: 'session' }, 'links_target_object_pair_check');
  });

  dbTest('preserves hidden tenant metadata on mapped link DTOs', async ({ db }) => {
    const repo = new LinksRepository(db);
    const rowToLink = (
      repo as unknown as {
        rowToLink(
          row: LinkRow & {
            tenant_id: string;
          }
        ): Link;
      }
    ).rowToLink.bind(repo);

    const link = rowToLink({
      tenant_id: 'tenant-a',
      link_id: generateId(),
      branch_id: generateId(),
      session_id: null,
      source_message_id: null,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/tenant',
      ref_uri: null,
      file_path: null,
      target_object_type: null,
      target_object_id: null,
      target_key: normalizeUrlTargetKey('https://example.com/tenant'),
      is_pinned: false,
      title: null,
      mime_type: null,
      metadata: null,
      created_by: null,
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-01-01T00:00:00.000Z'),
      revision: 1,
    });

    expect(Object.keys(link)).not.toContain('tenant_id');
    expect((link as unknown as { tenant_id?: string }).tenant_id).toBe('tenant-a');
  });

  dbTest('creates branch-owned and session-owned links with exactly one owner', async ({ db }) => {
    const { repo, branch, session } = await setupLinksRepository(db);

    const branchLink = await repo.create({
      branch_id: branch.branch_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/branch',
    });
    const sessionLink = await repo.create({
      session_id: session.session_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/session',
    });

    expect(branchLink.branch_id).toBe(branch.branch_id);
    expect(branchLink.session_id).toBeNull();
    expect(sessionLink.session_id).toBe(session.session_id);
    expect(sessionLink.branch_id).toBeNull();
    expect(sessionLink.revision).toBe(1);

    await expect(
      repo.create({
        branch_id: branch.branch_id,
        session_id: session.session_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/both',
      } as never)
    ).rejects.toThrow(/exactly one owner/);
  });

  dbTest('upserts by owner and target_key without piling up duplicates', async ({ db }) => {
    const repo = new LinksRepository(db);
    const branch = await seedBranch(db);
    const sessionA = await seedSession(db, branch.branch_id, 'owner' as UUID);
    const sessionB = await seedSession(db, branch.branch_id, 'owner' as UUID);

    const first = await repo.upsertWithStatus({
      session_id: sessionA.session_id,
      kind: 'url',
      source: 'parsed',
      url: 'https://example.com/repeat',
    });
    const second = await repo.upsertWithStatus({
      session_id: sessionA.session_id,
      kind: 'url',
      source: 'parsed',
      url: 'https://example.com/repeat',
      title: 'updated',
    });
    await repo.upsert({
      session_id: sessionB.session_id,
      kind: 'url',
      source: 'parsed',
      url: 'https://example.com/repeat',
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.link.title).toBe('updated');
    expect(await repo.findAll({ sessionId: sessionA.session_id })).toHaveLength(1);
    expect(await repo.findAll({ sessionId: sessionB.session_id })).toHaveLength(1);
  });

  dbTest('derives target_key instead of trusting caller-supplied keys', async ({ db }) => {
    const { repo, session } = await setupLinksRepository(db);

    const first = await repo.create({
      session_id: session.session_id,
      kind: 'url',
      source: 'manual',
      url: 'https://EXAMPLE.com/repeat#ignored',
      target_key: 'url:caller-spoofed',
    } as never);
    const second = await repo.create({
      session_id: session.session_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/repeat',
      target_key: 'url:caller-spoofed-again',
      title: 'deduped',
    } as never);

    expect(second.link_id).toBe(first.link_id);
    expect(second.target_key).toBe(normalizeUrlTargetKey('https://example.com/repeat'));
    expect(second.title).toBe('deduped');
    expect(await repo.findAll({ sessionId: session.session_id })).toHaveLength(1);
  });

  dbTest('keeps case-sensitive Knowledge paths as distinct targets', async ({ db }) => {
    const { repo, session } = await setupLinksRepository(db);

    const upper = await repo.create({
      session_id: session.session_id,
      kind: 'kb_ref',
      source: 'manual',
      ref_uri: 'agor://kb/team/Runbook.md',
    });
    const lower = await repo.create({
      session_id: session.session_id,
      kind: 'kb_ref',
      source: 'manual',
      ref_uri: 'agor://kb/team/runbook.md',
    });

    expect(lower.link_id).not.toBe(upper.link_id);
    expect(await repo.findAll({ sessionId: session.session_id })).toHaveLength(2);
  });

  dbTest('increments revision on every update', async ({ db }) => {
    const { repo, session } = await setupLinksRepository(db);
    const created = await repo.create({
      session_id: session.session_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/revision',
    });

    const first = await repo.update(created.link_id, { title: 'first' });
    const second = await repo.update(created.link_id, { title: 'second' });

    expect(created.revision).toBe(1);
    expect(first.revision).toBe(2);
    expect(second.revision).toBe(3);
  });

  dbTest('retries concurrent disjoint patches without losing either update', async ({ db }) => {
    const { repo, session } = await setupLinksRepository(db);
    const messageId = (await seedMessage(db, session.session_id)).message_id;
    const created = await repo.create({
      session_id: session.session_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/concurrent-patches',
    });

    const findById = repo.findById.bind(repo);
    let initialReads = 0;
    let releaseInitialReads: () => void = () => {};
    const bothInitialReadsComplete = new Promise<void>((resolve) => {
      releaseInitialReads = resolve;
    });
    vi.spyOn(repo, 'findById').mockImplementation(async (id) => {
      const link = await findById(id);
      initialReads += 1;
      if (initialReads === 2) releaseInitialReads();
      if (initialReads <= 2) await bothInitialReadsComplete;
      return link;
    });

    await Promise.all([
      repo.update(created.link_id, { is_pinned: true }),
      repo.update(created.link_id, { source_message_id: messageId }),
    ]);

    const updated = await findById(created.link_id);
    expect(updated).toMatchObject({
      is_pinned: true,
      source_message_id: messageId,
      revision: 3,
    });
  });

  dbTest('preserves the first source message when parsed-link dedupes race', async ({ db }) => {
    const { repo, session } = await setupLinksRepository(db);
    const firstMessageId = (await seedMessage(db, session.session_id)).message_id;
    const secondMessageId = (await seedMessage(db, session.session_id)).message_id;
    const created = await repo.create({
      session_id: session.session_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/concurrent-dedupe',
    });

    const findByOwnerAndTarget = repo.findByOwnerAndTarget.bind(repo);
    let initialReads = 0;
    let releaseInitialReads: () => void = () => {};
    const bothInitialReadsComplete = new Promise<void>((resolve) => {
      releaseInitialReads = resolve;
    });
    vi.spyOn(repo, 'findByOwnerAndTarget').mockImplementation(async (data) => {
      const link = await findByOwnerAndTarget(data);
      initialReads += 1;
      if (initialReads === 2) releaseInitialReads();
      if (initialReads <= 2) await bothInitialReadsComplete;
      return link;
    });

    const findById = repo.findById.bind(repo);
    let updateReads = 0;
    let releaseUpdateReads: () => void = () => {};
    const bothUpdateReadsComplete = new Promise<void>((resolve) => {
      releaseUpdateReads = resolve;
    });
    vi.spyOn(repo, 'findById').mockImplementation(async (id) => {
      const link = await findById(id);
      updateReads += 1;
      if (updateReads === 2) releaseUpdateReads();
      if (updateReads <= 2) await bothUpdateReadsComplete;
      return link;
    });

    const results = await Promise.all([
      repo.upsertWithStatus({
        session_id: session.session_id,
        kind: 'url',
        source: 'parsed',
        url: created.url,
        source_message_id: firstMessageId,
      }),
      repo.upsertWithStatus({
        session_id: session.session_id,
        kind: 'url',
        source: 'parsed',
        url: created.url,
        source_message_id: secondMessageId,
      }),
    ]);

    const updated = await findById(created.link_id);
    const firstApplied = results.find((result) => result.link.revision === 2)?.link;
    expect(updateReads).toBe(3);
    expect(firstApplied?.source_message_id).toBeTruthy();
    expect(
      results.every((result) => result.link.source_message_id === firstApplied?.source_message_id)
    ).toBe(true);
    expect(updated).toMatchObject({
      source: 'parsed',
      source_message_id: firstApplied?.source_message_id,
      revision: 3,
    });
  });

  dbTest(
    'preserves first source message attribution when deduping parsed links',
    async ({ db }) => {
      const { repo, session } = await setupLinksRepository(db);
      const firstMessageId = (await seedMessage(db, session.session_id)).message_id;
      const secondMessageId = (await seedMessage(db, session.session_id)).message_id;

      const first = await repo.create({
        session_id: session.session_id,
        source_message_id: firstMessageId,
        kind: 'url',
        source: 'parsed',
        url: 'https://example.com/repeated',
        title: 'first mention',
      });
      const second = await repo.create({
        session_id: session.session_id,
        source_message_id: secondMessageId,
        kind: 'url',
        source: 'parsed',
        url: 'https://example.com/repeated',
        title: 'latest title',
      });

      expect(second.link_id).toBe(first.link_id);
      expect(second.title).toBe('latest title');
      expect(second.source_message_id).toBe(firstMessageId);
      expect(await repo.findAll({ sourceMessageId: firstMessageId })).toHaveLength(1);
      expect(await repo.findAll({ sourceMessageId: secondMessageId })).toHaveLength(0);
    }
  );

  dbTest('fills missing source message attribution during dedupe', async ({ db }) => {
    const { repo, session } = await setupLinksRepository(db);
    const messageId = (await seedMessage(db, session.session_id)).message_id;

    const manual = await repo.create({
      session_id: session.session_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/later-attributed',
    });
    const attributed = await repo.create({
      session_id: session.session_id,
      source_message_id: messageId,
      kind: 'url',
      source: 'parsed',
      url: 'https://example.com/later-attributed',
    });

    expect(attributed.link_id).toBe(manual.link_id);
    expect(attributed.source_message_id).toBe(messageId);
  });

  dbTest('recomputes target_key and honors explicit null patch fields', async ({ db }) => {
    const { repo, session } = await setupLinksRepository(db);
    const created = await repo.create({
      session_id: session.session_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/original',
      title: 'Original',
      metadata: { note: 'clear me' },
    });

    const retargeted = await repo.update(created.link_id, {
      kind: 'kb_ref',
      url: null,
      ref_uri: 'agor://kb/team/runbook.md',
      title: null,
      metadata: null,
    });

    expect(retargeted.url).toBeNull();
    expect(retargeted.ref_uri).toBe('agor://kb/team/runbook.md');
    expect(retargeted.target_key).toBe(normalizeRefTargetKey('agor://kb/team/runbook.md'));
    expect(retargeted.title).toBeNull();
    expect(retargeted.metadata).toBeNull();
  });

  dbTest('rejects ambiguous or missing effective targets on create and patch', async ({ db }) => {
    const { repo, session } = await setupLinksRepository(db);
    const created = await repo.create({
      session_id: session.session_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/one',
    });

    await expect(
      repo.create({
        session_id: session.session_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/two',
        ref_uri: 'agor://kb/team/runbook.md',
      } as never)
    ).rejects.toThrow(/exactly one target/);
    await expect(
      repo.create({
        session_id: session.session_id,
        kind: 'url',
        source: 'manual',
        url: '   ',
      })
    ).rejects.toThrow(/exactly one target/);
    await expect(repo.update(created.link_id, { url: null })).rejects.toThrow(/exactly one target/);
    await expect(
      repo.update(created.link_id, { ref_uri: 'agor://kb/team/runbook.md' })
    ).rejects.toThrow(/exactly one target/);
  });

  dbTest(
    'rejects kind/source combinations that contradict the effective target',
    async ({ db }) => {
      const { repo, session } = await setupLinksRepository(db);
      const urlLink = await repo.create({
        session_id: session.session_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/manual',
      });
      const fileLink = await repo.create({
        session_id: session.session_id,
        kind: 'image',
        source: 'upload',
        file_path: '/uploads/image.png',
      });

      await expect(
        repo.create({
          session_id: session.session_id,
          kind: 'image',
          source: 'manual',
          url: 'https://example.com/not-an-image-file',
        } as never)
      ).rejects.toThrow(/requires target file_path/);
      await expect(
        repo.create({
          session_id: session.session_id,
          kind: 'kb_ref',
          source: 'manual',
          file_path: '/uploads/runbook.md',
        } as never)
      ).rejects.toThrow(/requires target ref_uri/);
      await expect(
        repo.create({
          session_id: session.session_id,
          kind: 'kb_ref',
          source: 'manual',
          ref_uri: `agor://session/${session.session_id}`,
        })
      ).rejects.toThrow(/agor:\/\/kb\//);
      await expect(repo.update(urlLink.link_id, { kind: 'document' })).rejects.toThrow(
        /requires target file_path/
      );
      await expect(repo.update(fileLink.link_id, { source: 'parsed' })).rejects.toThrow(
        /source parsed cannot use target file_path/
      );
    }
  );

  dbTest(
    'refetches and updates the existing link when an insert loses a dedupe race',
    async ({ db }) => {
      const { repo, session } = await setupLinksRepository(db);
      const createToInsert = (
        repo as unknown as {
          createToInsert(data: unknown, existing?: unknown): LinkInsert;
        }
      ).createToInsert.bind(repo);
      const existingRow = createToInsert({
        session_id: session.session_id,
        kind: 'url',
        source: 'parsed',
        url: 'https://example.com/race',
      });
      await insert(db, links).values(existingRow).returning().one();

      const findByOwnerAndTarget = repo.findByOwnerAndTarget.bind(repo);
      let missedPreflight = false;
      repo.findByOwnerAndTarget = async (...args) => {
        if (!missedPreflight) {
          missedPreflight = true;
          return null;
        }
        return findByOwnerAndTarget(...args);
      };

      const deduped = await repo.create({
        session_id: session.session_id,
        kind: 'url',
        source: 'parsed',
        url: 'https://example.com/race',
        title: 'race winner',
      });

      expect(deduped.title).toBe('race winner');
      expect(await repo.findAll({ sessionId: session.session_id })).toHaveLength(1);
    }
  );
});
