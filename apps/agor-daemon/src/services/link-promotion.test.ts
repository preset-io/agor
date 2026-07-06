import {
  BranchRepository,
  LinksRepository,
  RepoRepository,
  SessionRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Branch, BranchID, Link, SessionID, UUID } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import type { Database } from '../../../../packages/core/src/db/client';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { generateId } from '../../../../packages/core/src/lib/ids';
import { promoteLinkToAssistant } from './link-promotion';
import { LinksService } from './links';

async function seedUser(db: Database, userId: UUID, email: string) {
  await new UsersRepository(db).create({ user_id: userId, email, name: email });
}

async function seedRepo(db: Database) {
  return new RepoRepository(db).create({
    repo_id: generateId() as UUID,
    slug: `link-promotion-repo-${generateId()}`,
    name: 'Link Promotion Repo',
    repo_type: 'remote',
    remote_url: 'https://github.com/example/repo.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
}

async function seedBranch(
  db: Database,
  options: {
    createdBy?: UUID;
    assistant?: boolean;
    othersCan?: Branch['others_can'];
  } = {}
) {
  const repo = await seedRepo(db);
  return new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name: options.assistant ? `assistant-${generateId()}` : `branch-${generateId()}`,
    ref: 'refs/heads/test',
    branch_unique_id: 1,
    path: `/tmp/${generateId()}`,
    created_by: options.createdBy ?? ('owner' as UUID),
    permission_source: 'override',
    others_can: options.othersCan ?? 'view',
    custom_context: options.assistant
      ? { assistant: { kind: 'assistant', displayName: 'Assistant' } }
      : undefined,
  });
}

async function seedSession(db: Database, branchId: BranchID, createdBy: UUID = 'owner' as UUID) {
  return new SessionRepository(db).create({
    session_id: generateId() as SessionID,
    branch_id: branchId,
    created_by: createdBy,
    tasks: [],
    genealogy: { children: [] },
  });
}

function promotionDeps(db: Database, branchRbacEnabled = false) {
  return {
    linksService: new LinksService(db),
    branchRepository: new BranchRepository(db),
    branchRbacEnabled,
    superadminOpts: { allowSuperadmin: true },
  };
}

describe('promoteLinkToAssistant', () => {
  dbTest(
    'copies a session URL link into the assistant branch pinned and keeps the source',
    async ({ db }) => {
      const sourceBranch = await seedBranch(db);
      const assistant = await seedBranch(db, { assistant: true });
      const session = await seedSession(db, sourceBranch.branch_id);
      const source = await new LinksRepository(db).create({
        session_id: session.session_id,
        kind: 'url',
        source: 'parsed',
        url: 'https://example.com/docs',
        title: 'Docs',
        metadata: { sourceNote: 'keep' },
      });

      const promoted = await promoteLinkToAssistant(promotionDeps(db), {
        sourceLinkId: source.link_id,
        assistantBranchId: assistant.branch_id,
      });

      expect(promoted.link_id).not.toBe(source.link_id);
      expect(promoted.branch_id).toBe(assistant.branch_id);
      expect(promoted.session_id).toBeNull();
      expect(promoted.url).toBe(source.url);
      expect(promoted.source).toBe('manual');
      expect(promoted.is_pinned).toBe(true);
      expect(promoted.metadata).toMatchObject({
        sourceNote: 'keep',
        promoted_from_link_id: source.link_id,
        promoted_from_owner: { session_id: session.session_id },
      });

      expect(await new LinksRepository(db).findById(source.link_id)).toMatchObject({
        session_id: session.session_id,
        is_pinned: false,
      });
    }
  );

  dbTest(
    'copies ref and uploaded file links without browser-created file payloads',
    async ({ db }) => {
      const sourceBranch = await seedBranch(db);
      const assistant = await seedBranch(db, { assistant: true });
      const session = await seedSession(db, sourceBranch.branch_id);
      const repo = new LinksRepository(db);
      const refSource = await repo.create({
        session_id: session.session_id,
        kind: 'kb_ref',
        source: 'parsed',
        ref_uri: 'agor://kb/team/runbook.md',
        title: 'Runbook',
      });
      const fileSource = await repo.create({
        session_id: session.session_id,
        kind: 'document',
        source: 'upload',
        file_path: '/home/agor/.agor/uploads/session/spec.pdf',
        title: 'spec.pdf',
        mime_type: 'application/pdf',
      });

      const promotedRef = await promoteLinkToAssistant(promotionDeps(db), {
        sourceLinkId: refSource.link_id,
        assistantBranchId: assistant.branch_id,
      });
      const promotedFile = await promoteLinkToAssistant(promotionDeps(db), {
        sourceLinkId: fileSource.link_id,
        assistantBranchId: assistant.branch_id,
      });

      expect(promotedRef).toMatchObject({
        branch_id: assistant.branch_id,
        ref_uri: refSource.ref_uri,
        source: 'manual',
        is_pinned: true,
      });
      expect(promotedFile).toMatchObject({
        branch_id: assistant.branch_id,
        file_path: fileSource.file_path,
        source: 'upload',
        kind: 'document',
        mime_type: 'application/pdf',
        is_pinned: true,
      });
    }
  );

  dbTest('dedupes assistant copies by target_key and re-pins an existing copy', async ({ db }) => {
    const sourceBranch = await seedBranch(db);
    const assistant = await seedBranch(db, { assistant: true });
    const session = await seedSession(db, sourceBranch.branch_id);
    const repo = new LinksRepository(db);
    const source = await repo.create({
      session_id: session.session_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/repeat#ignored',
    });

    const first = await promoteLinkToAssistant(promotionDeps(db), {
      sourceLinkId: source.link_id,
      assistantBranchId: assistant.branch_id,
    });
    await new LinksService(db).patch(first.link_id, { is_pinned: false });
    const second = await promoteLinkToAssistant(promotionDeps(db), {
      sourceLinkId: source.link_id,
      assistantBranchId: assistant.branch_id,
    });

    expect(second.link_id).toBe(first.link_id);
    expect(second.is_pinned).toBe(true);
    expect(await repo.findAll({ branchId: assistant.branch_id })).toHaveLength(1);
  });

  dbTest('removing the assistant copy leaves the original source link intact', async ({ db }) => {
    const sourceBranch = await seedBranch(db);
    const assistant = await seedBranch(db, { assistant: true });
    const session = await seedSession(db, sourceBranch.branch_id);
    const repo = new LinksRepository(db);
    const source = await repo.create({
      session_id: session.session_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/remove-copy',
    });
    const promoted = await promoteLinkToAssistant(promotionDeps(db), {
      sourceLinkId: source.link_id,
      assistantBranchId: assistant.branch_id,
    });

    await new LinksService(db).remove(promoted.link_id);

    expect(await repo.findById(promoted.link_id)).toBeNull();
    expect(await repo.findById(source.link_id)).toMatchObject({ link_id: source.link_id });
  });

  dbTest('rejects non-assistant targets', async ({ db }) => {
    const sourceBranch = await seedBranch(db);
    const nonAssistant = await seedBranch(db);
    const session = await seedSession(db, sourceBranch.branch_id);
    const source = await new LinksRepository(db).create({
      session_id: session.session_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/not-assistant',
    });

    await expect(
      promoteLinkToAssistant(promotionDeps(db), {
        sourceLinkId: source.link_id,
        assistantBranchId: nonAssistant.branch_id,
      })
    ).rejects.toThrow(/not an assistant/);
  });

  dbTest(
    'requires all permission on the target assistant when branch RBAC is enabled',
    async ({ db }) => {
      const caller = generateId() as UUID;
      await seedUser(db, caller, 'promoter@example.com');
      const sourceBranch = await seedBranch(db, { othersCan: 'view' });
      const assistant = await seedBranch(db, { assistant: true, othersCan: 'view' });
      const session = await seedSession(db, sourceBranch.branch_id);
      const source = await new LinksRepository(db).create({
        session_id: session.session_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/rbac',
      });

      await expect(
        promoteLinkToAssistant(promotionDeps(db, true), {
          sourceLinkId: source.link_id,
          assistantBranchId: assistant.branch_id,
          params: {
            provider: 'rest',
            user: { user_id: caller, role: ROLES.MEMBER },
          } as never,
        })
      ).rejects.toThrow(/all' permission/);
    }
  );

  dbTest(
    'loads the source with caller params and creates assistant copy internally',
    async ({ db }) => {
      const assistant = await seedBranch(db, { assistant: true });
      const source = {
        link_id: generateId(),
        branch_id: null,
        session_id: generateId(),
        source_message_id: null,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/visible-source',
        ref_uri: null,
        file_path: null,
        target_key: 'url:https://example.com/visible-source',
        is_pinned: false,
        title: 'Visible source',
        mime_type: null,
        metadata: null,
        created_by: null,
        created_at: '2026-07-06T00:00:00.000Z',
        updated_at: '2026-07-06T00:00:00.000Z',
      } as Link;
      const get = vi.fn(async () => source);
      const create = vi.fn(async (data: unknown) => ({
        ...source,
        ...data,
        link_id: generateId(),
      }));
      const params = {
        provider: 'rest',
        user: { user_id: generateId(), role: ROLES.MEMBER },
        tenant: { tenant_id: 'tenant-a' },
      } as never;

      await promoteLinkToAssistant(
        {
          linksService: { get, create },
          branchRepository: new BranchRepository(db),
          branchRbacEnabled: false,
          superadminOpts: { allowSuperadmin: true },
        },
        {
          sourceLinkId: source.link_id,
          assistantBranchId: assistant.branch_id,
          params,
        }
      );

      expect(get).toHaveBeenCalledWith(source.link_id, params);
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          branch_id: assistant.branch_id,
          url: source.url,
          is_pinned: true,
        }),
        expect.objectContaining({ provider: undefined, tenant: { tenant_id: 'tenant-a' } })
      );
    }
  );
});
