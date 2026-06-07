import { eq } from 'drizzle-orm';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { GroupID, UserID } from '../../types';
import {
  buildKnowledgeUri,
  normalizeKnowledgePath,
  parseKnowledgeUri,
  validateKnowledgePath,
} from '../../types';
import type { Database } from '../client';
import { select, update } from '../database-wrapper';
import { kbDocumentUnits } from '../schema';
import { dbTest } from '../test-helpers';
import { GroupRepository } from './groups';
import {
  KnowledgeDocumentRepository,
  KnowledgeDocumentVersionRepository,
  KnowledgeNamespaceRepository,
  KnowledgeSearchRepository,
} from './knowledge';
import { UsersRepository } from './users';

async function seedUser(db: Database, label: string) {
  const users = new UsersRepository(db);
  return users.create({
    user_id: generateId() as UserID,
    email: `${label}-${Date.now()}-${Math.random()}@test.local`,
    name: label,
  });
}

describe('Knowledge path and URI helpers', () => {
  dbTest('normalizes filesystem-safe paths and parses canonical URIs', async () => {
    expect(normalizeKnowledgePath('/guides//intro.md')).toBe('guides/intro.md');
    expect(buildKnowledgeUri('global', '/guides//intro.md')).toBe(
      'agor://kb/global/guides/intro.md'
    );
    expect(parseKnowledgeUri('agor://kb/global/guides/intro.md')).toEqual({
      namespace_slug: 'global',
      path: 'guides/intro.md',
    });
    expect(validateKnowledgePath('../bad.md')).toContain('must not contain');
    expect(validateKnowledgePath('bad:name.md')).toContain('cannot contain');
    expect(validateKnowledgePath('CON/readme.md')).toContain('reserved');
  });
});

describe('Knowledge repositories', () => {
  dbTest(
    'resolves namespace permissions from others, users, groups, owners, and admins',
    async ({ db }) => {
      const owner = await seedUser(db, 'owner');
      const alice = await seedUser(db, 'alice');
      const bob = await seedUser(db, 'bob');
      const carol = await seedUser(db, 'carol');
      const namespaces = new KnowledgeNamespaceRepository(db);
      const groups = new GroupRepository(db);

      const namespace = await namespaces.create({
        slug: 'acl-test',
        display_name: 'ACL Test',
        owner_user_id: owner.user_id as UserID,
        others_can: 'none',
      });
      const group = await groups.create({ name: 'KB Writers', slug: 'kb-writers' });
      await groups.addMember(group.group_id, bob.user_id as UserID);

      expect(
        await namespaces.resolveNamespacePermission(namespace.namespace_id, alice.user_id)
      ).toBe('none');
      expect(
        await namespaces.resolveNamespacePermission(namespace.namespace_id, owner.user_id)
      ).toBe('own');
      expect(
        await namespaces.resolveNamespacePermission(namespace.namespace_id, carol.user_id, {
          isAdmin: true,
        })
      ).toBe('own');

      await namespaces.upsertNamespaceAclEntry({
        namespace_id: namespace.namespace_id,
        subject_type: 'user',
        subject_id: alice.user_id,
        permission: 'read',
      });
      await namespaces.upsertNamespaceAclEntry({
        namespace_id: namespace.namespace_id,
        subject_type: 'group',
        subject_id: group.group_id as GroupID,
        permission: 'write',
      });

      expect(
        await namespaces.resolveNamespacePermission(namespace.namespace_id, alice.user_id)
      ).toBe('read');
      expect(await namespaces.resolveNamespacePermission(namespace.namespace_id, bob.user_id)).toBe(
        'write'
      );

      await namespaces.update(namespace.namespace_id, { others_can: 'read' });
      expect(
        await namespaces.resolveNamespacePermission(namespace.namespace_id, carol.user_id)
      ).toBe('read');
    }
  );

  dbTest('upserts, lists, removes ACL entries, and reports readable namespaces', async ({ db }) => {
    const alice = await seedUser(db, 'readable-alice');
    const bob = await seedUser(db, 'readable-bob');
    const namespaces = new KnowledgeNamespaceRepository(db);

    const open = await namespaces.create({
      slug: 'readable-open',
      display_name: 'Readable Open',
      others_can: 'read',
    });
    const privateNamespace = await namespaces.create({
      slug: 'readable-private',
      display_name: 'Readable Private',
      others_can: 'none',
    });

    const entry = await namespaces.upsertNamespaceAclEntry({
      namespace_id: privateNamespace.namespace_id,
      subject_type: 'user',
      subject_id: alice.user_id,
      permission: 'read',
    });
    const updated = await namespaces.upsertNamespaceAclEntry({
      namespace_id: privateNamespace.namespace_id,
      subject_type: 'user',
      subject_id: alice.user_id,
      permission: 'own',
    });

    expect(updated.namespace_acl_id).toBe(entry.namespace_acl_id);
    expect(updated.permission).toBe('own');
    expect(await namespaces.listNamespaceAcl(privateNamespace.namespace_id)).toHaveLength(1);

    const aliceReadable = new Set(await namespaces.findReadableNamespaceIds(alice.user_id));
    expect(aliceReadable.has(open.namespace_id)).toBe(true);
    expect(aliceReadable.has(privateNamespace.namespace_id)).toBe(true);

    const bobReadable = new Set(await namespaces.findReadableNamespaceIds(bob.user_id));
    expect(bobReadable.has(open.namespace_id)).toBe(true);
    expect(bobReadable.has(privateNamespace.namespace_id)).toBe(false);

    const removed = await namespaces.removeNamespaceAclEntry(
      privateNamespace.namespace_id,
      'user',
      alice.user_id
    );
    expect(removed?.permission).toBe('own');
    expect(
      await namespaces.resolveNamespacePermission(privateNamespace.namespace_id, alice.user_id)
    ).toBe('none');
  });

  dbTest('creates markdown documents with version, unit, URI, and browser URL', async ({ db }) => {
    const owner = await seedUser(db, 'kb-owner');
    const namespaces = new KnowledgeNamespaceRepository(db);
    const documents = new KnowledgeDocumentRepository(db);
    const versions = new KnowledgeDocumentVersionRepository(db);

    const namespace = await namespaces.create({
      slug: 'repo-test',
      display_name: 'Repo Test',
      visibility_default: 'public',
      created_by: owner.user_id as UserID,
    });

    const created = await documents.create({
      namespace_id: namespace.namespace_id,
      path: 'guides/intro.md',
      title: 'Intro',
      content_text: '# Intro\n\nHello Knowledge',
      created_by: owner.user_id as UserID,
    });

    expect(created.uri).toBe('agor://kb/repo-test/guides/intro.md');
    expect(created.url).toContain('/ui/kb/repo-test/guides/intro.md');
    expect(created.current_version_id).toBeTruthy();
    expect(created.status).toBe('published');

    const history = await versions.findAll({ document_id: created.document_id });
    expect(history).toHaveLength(1);
    expect(history[0].version_number).toBe(1);
    expect(history[0].content_md5).toMatch(/^[a-f0-9]{32}$/);
    expect(history[0].content_sha256).toMatch(/^[a-f0-9]{64}$/);

    const units = await select(db)
      .from(kbDocumentUnits)
      .where(eq(kbDocumentUnits.document_id, created.document_id))
      .all();
    expect(units).toHaveLength(1);
    expect(units[0].version_id).toBe(created.current_version_id);
    expect(units[0].embedding_status).toBe('not_configured');
  });

  dbTest('updates content as immutable versions and updates path/URI', async ({ db }) => {
    const owner = await seedUser(db, 'kb-owner');
    const namespaces = new KnowledgeNamespaceRepository(db);
    const documents = new KnowledgeDocumentRepository(db);
    const versions = new KnowledgeDocumentVersionRepository(db);

    const namespace = await namespaces.create({
      slug: 'version-test',
      display_name: 'Version Test',
    });
    const created = await documents.create({
      namespace_id: namespace.namespace_id,
      path: 'old.md',
      title: 'Old',
      content_text: 'v1',
      created_by: owner.user_id as UserID,
    });

    const updated = await documents.update(created.document_id, {
      path: 'folder/new.md',
      title: 'New',
      content_text: 'v2',
      updated_by: owner.user_id as UserID,
      change_summary: 'Second version',
    });

    expect(updated.path).toBe('folder/new.md');
    expect(updated.uri).toBe('agor://kb/version-test/folder/new.md');
    expect(updated.current_version_id).not.toBe(created.current_version_id);

    const history = await versions.findAll({ document_id: created.document_id });
    expect(history.map((version) => version.version_number)).toEqual([2, 1]);
    expect(history[0].content_text).toBe('v2');
    expect(history[0].change_summary).toBe('Second version');

    const units = await select(db)
      .from(kbDocumentUnits)
      .where(eq(kbDocumentUnits.document_id, created.document_id))
      .all();
    expect(units).toHaveLength(2);
  });

  dbTest('summarizes indexing status for current document units', async ({ db }) => {
    const owner = await seedUser(db, 'kb-owner');
    const namespaces = new KnowledgeNamespaceRepository(db);
    const documents = new KnowledgeDocumentRepository(db);

    const namespace = await namespaces.create({
      slug: 'indexing-status-test',
      display_name: 'Indexing Status Test',
    });
    const created = await documents.create({
      namespace_id: namespace.namespace_id,
      path: 'indexed.md',
      title: 'Indexed',
      content_text: 'v1',
      created_by: owner.user_id as UserID,
    });

    const initial = (await documents.indexingStatusForDocuments([created.document_id])).get(
      created.document_id
    );
    expect(initial).toMatchObject({
      state: 'not_configured',
      total_units: 1,
      queue_depth: 0,
    });

    const updated = await documents.update(created.document_id, {
      content_text: 'v2',
      updated_by: owner.user_id as UserID,
    });
    expect(updated.current_version_id).toBeTruthy();
    await update(db, kbDocumentUnits)
      .set({ embedding_status: 'pending', updated_at: new Date() })
      .where(eq(kbDocumentUnits.version_id, updated.current_version_id as string))
      .run();

    const status = (await documents.indexingStatusForDocuments([created.document_id])).get(
      created.document_id
    );
    expect(status).toMatchObject({
      state: 'queued',
      total_units: 1,
      queue_depth: 1,
      chunks: expect.objectContaining({ pending: 1, not_configured: 0 }),
    });
  });

  dbTest('soft-delete allows path reuse while search hides archived documents', async ({ db }) => {
    const namespaces = new KnowledgeNamespaceRepository(db);
    const documents = new KnowledgeDocumentRepository(db);
    const search = new KnowledgeSearchRepository(db);
    const namespace = await namespaces.create({ slug: 'reuse-test', display_name: 'Reuse Test' });

    const first = await documents.create({
      namespace_id: namespace.namespace_id,
      path: 'same.md',
      title: 'First',
      content_text: 'first-only needle',
    });
    await documents.delete(first.document_id);

    const second = await documents.create({
      namespace_id: namespace.namespace_id,
      path: 'same.md',
      title: 'Second',
      content_text: 'second-only needle',
    });

    expect(second.document_id).not.toBe(first.document_id);
    expect(await documents.findByNamespaceAndPath(namespace.namespace_id, 'same.md')).toMatchObject(
      {
        document_id: second.document_id,
        title: 'Second',
      }
    );
    expect(await search.search({ q: 'first-only' })).toHaveLength(0);
    expect((await search.search({ q: 'second-only' }))[0].document.document_id).toBe(
      second.document_id
    );
  });

  dbTest('search scopes private results before applying limits', async ({ db }) => {
    const alice = await seedUser(db, 'alice');
    const bob = await seedUser(db, 'bob');
    const namespaces = new KnowledgeNamespaceRepository(db);
    const documents = new KnowledgeDocumentRepository(db);
    const search = new KnowledgeSearchRepository(db);
    const namespace = await namespaces.create({ slug: 'search-test', display_name: 'Search Test' });

    await documents.create({
      namespace_id: namespace.namespace_id,
      path: 'private.md',
      title: 'Secret',
      visibility: 'private',
      content_text: 'sharedneedle private',
      created_by: alice.user_id as UserID,
    });
    const publicDoc = await documents.create({
      namespace_id: namespace.namespace_id,
      path: 'public.md',
      title: 'Public',
      visibility: 'public',
      content_text: 'sharedneedle public',
      created_by: alice.user_id as UserID,
    });

    const asBob = await search.search({
      q: 'sharedneedle',
      limit: 10,
      readable_by_user_id: bob.user_id as UserID,
    });
    expect(asBob.map((result) => result.document.document_id)).toEqual([publicDoc.document_id]);

    const asAlice = await search.search({
      q: 'sharedneedle',
      readable_by_user_id: alice.user_id as UserID,
    });
    expect(new Set(asAlice.map((result) => result.document.visibility))).toEqual(
      new Set(['private', 'public'])
    );
  });

  dbTest('search path_prefix accepts trailing folder slashes', async ({ db }) => {
    const namespaces = new KnowledgeNamespaceRepository(db);
    const documents = new KnowledgeDocumentRepository(db);
    const search = new KnowledgeSearchRepository(db);
    const namespace = await namespaces.create({
      slug: 'path-prefix-test',
      display_name: 'Path Prefix Test',
    });

    const guide = await documents.create({
      namespace_id: namespace.namespace_id,
      path: 'guides/intro.md',
      title: 'Intro',
      content_text: 'prefixneedle guide',
    });
    await documents.create({
      namespace_id: namespace.namespace_id,
      path: 'notes/intro.md',
      title: 'Note',
      content_text: 'prefixneedle note',
    });

    const withoutSlash = await search.search({
      q: 'prefixneedle',
      namespace_slug: namespace.slug,
      path_prefix: 'guides',
    });
    const withSlash = await search.search({
      q: 'prefixneedle',
      namespace_slug: namespace.slug,
      path_prefix: 'guides/',
    });

    expect(withoutSlash.map((result) => result.document.document_id)).toEqual([guide.document_id]);
    expect(withSlash.map((result) => result.document.document_id)).toEqual([guide.document_id]);
  });

  dbTest('namespace kind filtering includes user namespaces', async ({ db }) => {
    const namespaces = new KnowledgeNamespaceRepository(db);
    const userNamespace = await namespaces.create({
      slug: 'user-kind-test',
      display_name: 'User Kind Test',
      kind: 'user',
    });
    await namespaces.create({
      slug: 'global-kind-test',
      display_name: 'Global Kind Test',
      kind: 'global',
    });

    const userNamespaces = await namespaces.findAll({ kind: 'user' });

    expect(userNamespaces.map((namespace) => namespace.namespace_id)).toEqual([
      userNamespace.namespace_id,
    ]);
  });
});
