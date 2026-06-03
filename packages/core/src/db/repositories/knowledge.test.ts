import { eq } from 'drizzle-orm';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { UserID } from '../../types';
import {
  buildKnowledgeUri,
  normalizeKnowledgePath,
  parseKnowledgeUri,
  validateKnowledgePath,
} from '../../types';
import type { Database } from '../client';
import { select } from '../database-wrapper';
import { kbDocumentUnits } from '../schema';
import { dbTest } from '../test-helpers';
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
});
