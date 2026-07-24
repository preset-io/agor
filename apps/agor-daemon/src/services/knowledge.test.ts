import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  __resetConfigCacheForTests,
  type AgorConfig,
  loadConfig,
  saveConfig,
} from '@agor/core/config';
import type { Database } from '@agor/core/db';
import {
  eq,
  GroupRepository,
  generateId,
  KnowledgeDocumentRepository,
  KnowledgeNamespaceRepository,
  kbDocumentUnits,
  select,
  UsersRepository,
} from '@agor/core/db';
import { BadRequest, Forbidden, NotFound } from '@agor/core/feathers';
import type { KnowledgeDocument, User, UserID } from '@agor/core/types';
import { parseKnowledgeUri, ROLES } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { knowledgeChunkerOptionsFromSettings, knowledgeUnitsForMarkdown } from '../knowledge/units';
import { KnowledgeDocumentsService } from './knowledge-documents';
import { KnowledgeEmbeddingIndexer } from './knowledge-embedding-indexer';
import { KnowledgeGraphService } from './knowledge-graph';
import { KnowledgeIndexingStatusService } from './knowledge-indexing';
import { KnowledgeNamespacesService } from './knowledge-namespaces';
import { KnowledgeReindexService } from './knowledge-reindex';
import { KnowledgeSearchService } from './knowledge-search';
import { KnowledgeSettingsService } from './knowledge-settings';
import { KnowledgeVersionsService } from './knowledge-versions';

async function seedUser(
  db: Database,
  label: string,
  role: User['role'] = ROLES.MEMBER
): Promise<User> {
  const users = new UsersRepository(db);
  return users.create({
    user_id: generateId() as UserID,
    email: `${label}-${Date.now()}-${Math.random()}@test.local`,
    name: label,
    role,
  }) as Promise<User>;
}

async function seedNamespace(
  db: Database,
  slug = `kb-${Date.now()}-${Math.random().toString(16).slice(2)}`
) {
  return new KnowledgeNamespaceRepository(db).create({ slug, display_name: slug });
}

async function seedDocument(
  db: Database,
  owner: User,
  overrides: Partial<KnowledgeDocument> & { content_text?: string } = {}
) {
  const namespace = await seedNamespace(
    db,
    `svc-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const documents = new KnowledgeDocumentRepository(db);
  return documents.create({
    namespace_id: namespace.namespace_id,
    path: overrides.path ?? 'page.md',
    title: overrides.title ?? 'Page',
    visibility: overrides.visibility ?? 'public',
    status: overrides.status ?? 'published',
    edit_policy: overrides.edit_policy ?? 'owner',
    content_text: overrides.content_text ?? '# Page\n\nBody',
    created_by: owner.user_id as UserID,
  });
}

function params(user: User, query?: Record<string, unknown>) {
  return { user, query } as never;
}

async function withTempConfig<T>(config: AgorConfig, run: () => Promise<T>): Promise<T> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-kb-service-test-'));
  const spy = vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
  __resetConfigCacheForTests();
  try {
    await saveConfig(config);
    return await run();
  } finally {
    __resetConfigCacheForTests();
    spy.mockRestore();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

describe('KnowledgeNamespacesService permissions', () => {
  dbTest('saves namespace fields and ACL draft through one service method', async ({ db }) => {
    const owner = await seedUser(db, 'owner');
    const other = await seedUser(db, 'other');
    const service = new KnowledgeNamespacesService(db);

    const created = await service.saveWithAcl(
      {
        namespace: {
          slug: 'atomic-acl',
          display_name: 'Atomic ACL',
          others_can: 'none',
        },
        acl: [
          {
            subject_type: 'user',
            subject_id: other.user_id,
            permission: 'read',
          },
        ],
      },
      params(owner)
    );

    expect(created.namespace.display_name).toBe('Atomic ACL');
    expect(created.acl).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject_type: 'user',
          subject_id: owner.user_id,
          permission: 'own',
        }),
        expect.objectContaining({
          subject_type: 'user',
          subject_id: other.user_id,
          permission: 'read',
        }),
      ])
    );

    const updated = await service.saveWithAcl(
      {
        namespace_id: created.namespace.namespace_id,
        namespace: {
          display_name: 'Updated ACL',
          slug: created.namespace.slug,
          others_can: 'read',
        },
        acl: [
          {
            subject_type: 'user',
            subject_id: other.user_id,
            permission: 'write',
          },
        ],
      },
      params(owner)
    );

    expect(updated.namespace.display_name).toBe('Updated ACL');
    expect(updated.namespace.others_can).toBe('read');
    expect(updated.acl).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject_type: 'user',
          subject_id: owner.user_id,
          permission: 'own',
        }),
        expect.objectContaining({
          subject_type: 'user',
          subject_id: other.user_id,
          permission: 'write',
        }),
      ])
    );
  });

  dbTest('reports effective permissions when listing readable namespaces', async ({ db }) => {
    const owner = await seedUser(db, 'owner');
    const reader = await seedUser(db, 'reader');
    const namespaces = new KnowledgeNamespaceRepository(db);
    const readable = await namespaces.create({
      slug: 'list-readable',
      display_name: 'List Readable',
      others_can: 'none',
      owner_user_id: owner.user_id as UserID,
    });
    await namespaces.upsertNamespaceAclEntry({
      namespace_id: readable.namespace_id,
      subject_type: 'user',
      subject_id: reader.user_id,
      permission: 'read',
    });

    const service = new KnowledgeNamespacesService(db);
    await expect(service.find(params(reader))).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          namespace_id: readable.namespace_id,
          effective_permission: 'read',
        }),
      ])
    );
    await expect(service.find(params(owner))).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          namespace_id: readable.namespace_id,
          effective_permission: 'own',
        }),
      ])
    );
    await expect(service.get(readable.namespace_id, params(reader))).resolves.toMatchObject({
      namespace_id: readable.namespace_id,
      effective_permission: 'read',
    });
  });

  dbTest('prevents ACL methods from removing the caller last owner path', async ({ db }) => {
    const owner = await seedUser(db, 'owner');
    const service = new KnowledgeNamespacesService(db);
    const namespaces = new KnowledgeNamespaceRepository(db);
    const namespace = await namespaces.create({
      slug: 'no-self-lock',
      display_name: 'No Self Lock',
      others_can: 'none',
      owner_user_id: null,
    });
    await namespaces.upsertNamespaceAclEntry({
      namespace_id: namespace.namespace_id,
      subject_type: 'user',
      subject_id: owner.user_id,
      permission: 'own',
    });

    await expect(
      service.setAcl(
        {
          namespace_id: namespace.namespace_id,
          subject_type: 'user',
          subject_id: owner.user_id,
          permission: 'write',
        },
        params(owner)
      )
    ).rejects.toBeInstanceOf(BadRequest);
    await expect(
      service.removeAcl(
        {
          namespace_id: namespace.namespace_id,
          subject_type: 'user',
          subject_id: owner.user_id,
        },
        params(owner)
      )
    ).rejects.toBeInstanceOf(BadRequest);
  });

  dbTest(
    'prevents owner_user_id changes from removing the caller last owner path',
    async ({ db }) => {
      const owner = await seedUser(db, 'owner');
      const replacement = await seedUser(db, 'replacement');
      const service = new KnowledgeNamespacesService(db);
      const namespaces = new KnowledgeNamespaceRepository(db);
      const namespace = await namespaces.create({
        slug: 'owner-user-self-lock',
        display_name: 'Owner User Self Lock',
        others_can: 'none',
        owner_user_id: owner.user_id as UserID,
      });

      await expect(
        service.patch(
          namespace.namespace_id,
          { owner_user_id: replacement.user_id as UserID },
          params(owner)
        )
      ).rejects.toBeInstanceOf(BadRequest);

      await namespaces.upsertNamespaceAclEntry({
        namespace_id: namespace.namespace_id,
        subject_type: 'user',
        subject_id: owner.user_id,
        permission: 'own',
      });
      await expect(
        service.patch(
          namespace.namespace_id,
          { owner_user_id: replacement.user_id as UserID },
          params(owner)
        )
      ).resolves.toMatchObject({ owner_user_id: replacement.user_id });
    }
  );

  dbTest(
    'allows ACL owner changes when the caller keeps owner access through a group',
    async ({ db }) => {
      const owner = await seedUser(db, 'owner');
      const service = new KnowledgeNamespacesService(db);
      const namespaces = new KnowledgeNamespaceRepository(db);
      const groups = new GroupRepository(db);
      const group = await groups.create({ name: 'Namespace Owners', slug: 'namespace-owners' });
      await groups.addMember(group.group_id, owner.user_id);
      const namespace = await namespaces.create({
        slug: 'group-owned-acl',
        display_name: 'Group Owned ACL',
        others_can: 'none',
        owner_user_id: null,
      });
      await namespaces.upsertNamespaceAclEntry({
        namespace_id: namespace.namespace_id,
        subject_type: 'user',
        subject_id: owner.user_id,
        permission: 'own',
      });
      await namespaces.upsertNamespaceAclEntry({
        namespace_id: namespace.namespace_id,
        subject_type: 'group',
        subject_id: group.group_id,
        permission: 'own',
      });

      await expect(
        service.setAcl(
          {
            namespace_id: namespace.namespace_id,
            subject_type: 'user',
            subject_id: owner.user_id,
            permission: 'read',
          },
          params(owner)
        )
      ).resolves.toMatchObject({ permission: 'read' });
      await expect(
        service.listAcl({ namespace_id: namespace.namespace_id }, params(owner))
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            subject_type: 'group',
            subject_id: group.group_id,
            permission: 'own',
          }),
        ])
      );
    }
  );
});

describe('KnowledgeDocumentsService permissions', () => {
  dbTest(
    'enforces private/public read access and owner/admin visibility changes',
    async ({ db }) => {
      const owner = await seedUser(db, 'owner');
      const other = await seedUser(db, 'other');
      const admin = await seedUser(db, 'admin', ROLES.ADMIN);
      const service = new KnowledgeDocumentsService(db);
      const privateDoc = await seedDocument(db, owner, { visibility: 'private' });

      await expect(service.get(privateDoc.document_id, params(other))).rejects.toBeInstanceOf(
        Forbidden
      );
      await expect(service.get(privateDoc.document_id, params(owner))).resolves.toMatchObject({
        document_id: privateDoc.document_id,
      });

      await expect(
        service.patch(privateDoc.document_id, { visibility: 'public' }, params(other))
      ).rejects.toBeInstanceOf(Forbidden);

      await expect(
        service.patch(privateDoc.document_id, { visibility: 'public' }, params(admin))
      ).resolves.toMatchObject({ visibility: 'public' });
    }
  );

  dbTest('allows public edits without allowing governance changes or deletion', async ({ db }) => {
    const owner = await seedUser(db, 'owner');
    const other = await seedUser(db, 'other');
    const service = new KnowledgeDocumentsService(db);
    const publicEditable = await seedDocument(db, owner, {
      visibility: 'public',
      edit_policy: 'public',
      content_text: 'v1',
    });

    const edited = await service.patch(
      publicEditable.document_id,
      { content_text: 'v2', change_summary: 'community edit' },
      params(other)
    );
    expect(edited.current_version_id).not.toBe(publicEditable.current_version_id);

    await expect(
      service.patch(publicEditable.document_id, { edit_policy: 'owner' }, params(other))
    ).rejects.toBeInstanceOf(Forbidden);
    await expect(service.remove(publicEditable.document_id, params(other))).rejects.toBeInstanceOf(
      Forbidden
    );
  });

  dbTest(
    'does not treat private documents with public edit policy as world-editable',
    async ({ db }) => {
      const owner = await seedUser(db, 'owner');
      const other = await seedUser(db, 'other');
      const service = new KnowledgeDocumentsService(db);
      const privateEditable = await seedDocument(db, owner, {
        visibility: 'private',
        edit_policy: 'public',
        content_text: 'v1',
      });

      await expect(
        service.patch(privateEditable.document_id, { content_text: 'v2' }, params(other))
      ).rejects.toBeInstanceOf(Forbidden);
    }
  );

  dbTest(
    'upserts by namespace/path and returns current content for MCP-style get',
    async ({ db }) => {
      const owner = await seedUser(db, 'owner');
      const namespace = await seedNamespace(db, 'mcp-style');
      const service = new KnowledgeDocumentsService(db);

      const created = await service.putDocument(
        {
          namespace_slug: namespace.slug,
          path: 'guide.md',
          content_text: '# Guide\n\nInitial',
          first_line_is_title: true,
          icon_emoji: '📘',
        },
        params(owner)
      );
      expect(created.title).toBe('Guide');
      expect(created.uri).toBe('agor://kb/mcp-style/guide.md');
      expect(created.icon_emoji).toBe('📘');

      const updated = await service.putDocument(
        {
          namespace_slug: namespace.slug,
          path: 'guide.md',
          content_text: '# Guide\n\nUpdated',
          expected_version: 1,
        },
        params(owner)
      );
      expect(updated.document_id).toBe(created.document_id);
      expect(updated.icon_emoji).toBe('📘');

      const iconOnlyUpdate = await service.putDocument(
        {
          document_id: created.document_id,
          icon_emoji: '🧭',
        },
        params(owner)
      );
      expect(iconOnlyUpdate.document_id).toBe(created.document_id);
      expect(iconOnlyUpdate.icon_emoji).toBe('🧭');
      expect(iconOnlyUpdate.current_version_id).toBe(updated.current_version_id);

      const hydrated = await service.getDocument(
        { namespace_slug: namespace.slug, path: 'guide.md', include_content: true },
        params(owner)
      );
      expect('content' in hydrated ? hydrated.content : null).toBe('# Guide\n\nUpdated');
    }
  );

  dbTest(
    'hides archived documents from direct get and recreates same path through upsert',
    async ({ db }) => {
      const owner = await seedUser(db, 'owner');
      const namespace = await seedNamespace(db, 'archive-style');
      const service = new KnowledgeDocumentsService(db);

      const created = await service.putDocument(
        { namespace_slug: namespace.slug, path: 'same.md', content_text: 'old' },
        params(owner)
      );
      await service.remove(created.document_id, params(owner));
      await expect(service.get(created.document_id, params(owner))).rejects.toBeInstanceOf(
        NotFound
      );

      const recreated = await service.putDocument(
        { namespace_slug: namespace.slug, path: 'same.md', content_text: 'new' },
        params(owner)
      );
      expect(recreated.document_id).not.toBe(created.document_id);
    }
  );

  dbTest('enforces namespace read/write as outer gate for documents', async ({ db }) => {
    const owner = await seedUser(db, 'owner');
    const other = await seedUser(db, 'other');
    const namespaces = new KnowledgeNamespaceRepository(db);
    const namespace = await namespaces.create({
      slug: 'namespace-gated-docs',
      display_name: 'Namespace Gated Docs',
      owner_user_id: owner.user_id as UserID,
      others_can: 'none',
    });
    const service = new KnowledgeDocumentsService(db);
    const doc = await service.create(
      {
        namespace_id: namespace.namespace_id,
        path: 'shared.md',
        title: 'Shared',
        visibility: 'public',
        edit_policy: 'public',
        content_text: 'v1',
      },
      params(owner)
    );

    await expect(service.get(doc.document_id, params(other))).rejects.toBeInstanceOf(Forbidden);

    await namespaces.upsertNamespaceAclEntry({
      namespace_id: namespace.namespace_id,
      subject_type: 'user',
      subject_id: other.user_id,
      permission: 'read',
    });
    await expect(service.get(doc.document_id, params(other))).resolves.toMatchObject({
      document_id: doc.document_id,
    });
    await expect(
      service.patch(doc.document_id, { content_text: 'v2' }, params(other))
    ).rejects.toBeInstanceOf(Forbidden);

    await namespaces.upsertNamespaceAclEntry({
      namespace_id: namespace.namespace_id,
      subject_type: 'user',
      subject_id: other.user_id,
      permission: 'write',
    });
    await expect(
      service.patch(doc.document_id, { content_text: 'v2' }, params(other))
    ).resolves.toMatchObject({ document_id: doc.document_id });
  });

  dbTest('enforces group namespace grants through document services', async ({ db }) => {
    const owner = await seedUser(db, 'owner');
    const groupMember = await seedUser(db, 'group-member');
    const groups = new GroupRepository(db);
    const group = await groups.create({ name: 'KB Editors', slug: 'kb-editors' });
    await groups.addMember(group.group_id, groupMember.user_id);
    const namespaces = new KnowledgeNamespaceRepository(db);
    const namespace = await namespaces.create({
      slug: 'group-gated-docs',
      display_name: 'Group Gated Docs',
      owner_user_id: owner.user_id as UserID,
      others_can: 'none',
    });
    const service = new KnowledgeDocumentsService(db);
    const doc = await service.create(
      {
        namespace_id: namespace.namespace_id,
        path: 'group.md',
        title: 'Group',
        visibility: 'public',
        edit_policy: 'public',
        content_text: 'v1',
      },
      params(owner)
    );

    await expect(service.get(doc.document_id, params(groupMember))).rejects.toBeInstanceOf(
      Forbidden
    );

    await namespaces.upsertNamespaceAclEntry({
      namespace_id: namespace.namespace_id,
      subject_type: 'group',
      subject_id: group.group_id,
      permission: 'write',
    });

    await expect(service.get(doc.document_id, params(groupMember))).resolves.toMatchObject({
      document_id: doc.document_id,
    });
    await expect(
      service.patch(doc.document_id, { content_text: 'v2' }, params(groupMember))
    ).resolves.toMatchObject({ document_id: doc.document_id });
  });

  dbTest('filters search results by readable namespaces', async ({ db }) => {
    const owner = await seedUser(db, 'owner');
    const other = await seedUser(db, 'other');
    const namespaces = new KnowledgeNamespaceRepository(db);
    const openNamespace = await namespaces.create({
      slug: 'search-open-namespace',
      display_name: 'Search Open Namespace',
      others_can: 'read',
    });
    const closedNamespace = await namespaces.create({
      slug: 'search-closed-namespace',
      display_name: 'Search Closed Namespace',
      owner_user_id: owner.user_id as UserID,
      others_can: 'none',
    });
    const documents = new KnowledgeDocumentRepository(db);
    await documents.create({
      namespace_id: openNamespace.namespace_id,
      path: 'open.md',
      title: 'Open',
      visibility: 'public',
      content_text: 'namespaceneedle open',
      created_by: owner.user_id as UserID,
    });
    await documents.create({
      namespace_id: closedNamespace.namespace_id,
      path: 'closed.md',
      title: 'Closed',
      visibility: 'public',
      content_text: 'namespaceneedle closed',
      created_by: owner.user_id as UserID,
    });

    const search = new KnowledgeSearchService(db);
    const results = await search.create({ q: 'namespaceneedle' }, params(other));
    expect(results.map((result) => result.namespace.slug)).toEqual(['search-open-namespace']);
  });

  dbTest('filters text search by readable namespaces before applying row cap', async ({ db }) => {
    const owner = await seedUser(db, 'owner');
    const other = await seedUser(db, 'other');
    const namespaces = new KnowledgeNamespaceRepository(db);
    const openNamespace = await namespaces.create({
      slug: 'search-starvation-open',
      display_name: 'Search Starvation Open',
      others_can: 'read',
    });
    const closedNamespace = await namespaces.create({
      slug: 'search-starvation-closed',
      display_name: 'Search Starvation Closed',
      owner_user_id: owner.user_id as UserID,
      others_can: 'none',
    });
    const documents = new KnowledgeDocumentRepository(db);
    await documents.create({
      namespace_id: openNamespace.namespace_id,
      path: 'open-starvation.md',
      title: 'Open Starvation',
      visibility: 'public',
      content_text: 'starvationneedle readable',
      created_by: owner.user_id as UserID,
      updated_at: new Date('2026-01-01T00:00:00.000Z'),
    });
    for (let index = 0; index < 120; index += 1) {
      await documents.create({
        namespace_id: closedNamespace.namespace_id,
        path: `closed-${index}.md`,
        title: `Closed ${index}`,
        visibility: 'public',
        content_text: `starvationneedle closed ${index}`,
        created_by: owner.user_id as UserID,
        updated_at: new Date(Date.UTC(2026, 0, 2, 0, 0, index)),
      });
    }

    const search = new KnowledgeSearchService(db);
    const results = await search.create({ q: 'starvationneedle', limit: 10 }, params(other));
    expect(results.map((result) => result.namespace.slug)).toEqual(['search-starvation-open']);
  });
});

describe('Knowledge semantic indexing lifecycle', () => {
  dbTest('rejects unsupported providers and normalizes blank API keys', async ({ db }) => {
    await withTempConfig({ daemon: { port: 4321 } }, async () => {
      const admin = await seedUser(db, 'admin', ROLES.ADMIN);
      const settings = new KnowledgeSettingsService(db);
      const configBefore = await loadConfig();

      await expect(
        settings.patch(null, { provider: 'voyage' as never }, params(admin))
      ).rejects.toBeInstanceOf(BadRequest);

      const saved = await settings.patch(
        null,
        { enabled: true, provider: 'openai', api_key: '   ' },
        params(admin)
      );
      expect(saved.api_key_configured).toBe(false);
      expect(await loadConfig()).toEqual(configBefore);
    });
  });

  dbTest('reindex rebuilds chunks from current document content on SQLite', async ({ db }) => {
    await withTempConfig({}, async () => {
      await new KnowledgeSettingsService(db).patch(null, {
        enabled: true,
        provider: 'openai',
        chunking: {
          target_tokens: 40,
          max_tokens: 60,
          overlap_tokens: 0,
          min_tokens: 1,
        },
      });
      const owner = await seedUser(db, 'owner');
      const doc = await seedDocument(db, owner, {
        content_text: `# Big\n\n${Array.from({ length: 500 }, (_, i) => `word${i}`).join(' ')}`,
      });

      const result = await new KnowledgeReindexService(db).create();
      expect(result.status).toBe('not_configured');
      expect(result.queued).toBeGreaterThan(1);

      const units = await select(db)
        .from(kbDocumentUnits)
        .where(eq(kbDocumentUnits.version_id, doc.current_version_id))
        .all();
      expect(units).toHaveLength(result.queued);
      expect(new Set(units.map((unit) => unit.embedding_status))).toEqual(
        new Set(['not_configured'])
      );
    });
  });

  dbTest(
    'commits concurrent chunking policy and rebuilt units atomically on SQLite',
    async ({ db }) => {
      const owner = await seedUser(db, 'chunk-policy-owner');
      const content = `# Big\n\n${Array.from({ length: 500 }, (_, i) => `word${i}`).join(' ')}`;
      const doc = await seedDocument(db, owner, { content_text: content });
      const settings = new KnowledgeSettingsService(db);

      await Promise.all([
        settings.patch(null, {
          chunking: { target_tokens: 40, max_tokens: 60, overlap_tokens: 0, min_tokens: 1 },
        }),
        settings.patch(null, {
          chunking: { target_tokens: 80, max_tokens: 100, overlap_tokens: 10, min_tokens: 1 },
        }),
      ]);

      const saved = await settings.find();
      const units = await select(db)
        .from(kbDocumentUnits)
        .where(eq(kbDocumentUnits.version_id, doc.current_version_id))
        .all();
      const expected = knowledgeUnitsForMarkdown(
        doc.path,
        content,
        knowledgeChunkerOptionsFromSettings(saved)
      );
      expect(units.map((unit) => unit.content_md5).sort()).toEqual(
        expected.map((unit) => unit.content_md5).sort()
      );
    }
  );

  dbTest(
    'serializes document-unit writes with concurrent chunking policy changes on SQLite',
    async ({ db }) => {
      const owner = await seedUser(db, 'document-policy-owner');
      const original = await seedDocument(db, owner, { content_text: '# Original\n\nshort' });
      const content = `# Updated\n\n${Array.from({ length: 500 }, (_, i) => `word${i}`).join(' ')}`;
      const documents = new KnowledgeDocumentsService(db);
      const settings = new KnowledgeSettingsService(db);

      await Promise.all([
        documents.patch(original.document_id, { content_text: content }, params(owner)),
        settings.patch(null, {
          chunking: { target_tokens: 40, max_tokens: 60, overlap_tokens: 0, min_tokens: 1 },
        }),
      ]);

      const saved = await settings.find();
      const document = await documents.get(original.document_id, params(owner));
      const units = await select(db)
        .from(kbDocumentUnits)
        .where(eq(kbDocumentUnits.version_id, document.current_version_id))
        .all();
      const expected = knowledgeUnitsForMarkdown(
        document.path,
        content,
        knowledgeChunkerOptionsFromSettings(saved)
      );
      expect(units.map((unit) => unit.content_md5).sort()).toEqual(
        expected.map((unit) => unit.content_md5).sort()
      );
    }
  );

  dbTest('serializes manual reindex with chunking policy changes on SQLite', async ({ db }) => {
    const owner = await seedUser(db, 'reindex-policy-owner');
    const content = `# Reindex\n\n${Array.from({ length: 500 }, (_, i) => `word${i}`).join(' ')}`;
    const document = await seedDocument(db, owner, { content_text: content });
    const settings = new KnowledgeSettingsService(db);

    await Promise.all([
      new KnowledgeReindexService(db).create(),
      settings.patch(null, {
        chunking: { target_tokens: 40, max_tokens: 60, overlap_tokens: 0, min_tokens: 1 },
      }),
    ]);

    const saved = await settings.find();
    const units = await select(db)
      .from(kbDocumentUnits)
      .where(eq(kbDocumentUnits.version_id, document.current_version_id))
      .all();
    const expected = knowledgeUnitsForMarkdown(
      document.path,
      content,
      knowledgeChunkerOptionsFromSettings(saved)
    );
    expect(units.map((unit) => unit.content_md5).sort()).toEqual(
      expected.map((unit) => unit.content_md5).sort()
    );
  });

  dbTest('indexing status separates pgvector extension from usable storage', async ({ db }) => {
    await withTempConfig({}, async () => {
      await new KnowledgeSettingsService(db).patch(null, {
        enabled: true,
        provider: 'openai',
      });
      const status = await new KnowledgeIndexingStatusService(db).find();

      expect(status.pgvector_available).toBe(false);
      expect(status.pgvector_extension_installed).toBe(false);
      expect(status.pgvector_storage_ready).toBe(false);
      expect(status.last_error).toContain('not PostgreSQL');
    });
  });

  dbTest(
    'indexing status hides stale indexer errors when semantic search is disabled',
    async ({ db }) => {
      await withTempConfig({}, async () => {
        const app = {
          get: (key: string) =>
            key === 'knowledgeEmbeddingIndexer'
              ? { getLastError: () => 'old pgvector error', getLastIndexedAt: () => null }
              : undefined,
        } as never;

        const status = await new KnowledgeIndexingStatusService(db, app).find();

        expect(status.enabled).toBe(false);
        expect(status.last_error).toBeNull();
      });
    }
  );

  dbTest(
    'indexer clears stale pgvector errors when semantic indexing is disabled',
    async ({ db }) => {
      await withTempConfig({}, async () => {
        const indexer = new KnowledgeEmbeddingIndexer(db);
        (
          indexer as unknown as { lastErrorByTenant: Map<string, string | null> }
        ).lastErrorByTenant.set('default', 'old pgvector error');

        await expect(indexer.indexBatch()).resolves.toBe(0);
        expect(indexer.getLastError()).toBeNull();
        expect(indexer.getLastError('another-tenant')).toBeNull();
      });
    }
  );

  dbTest(
    'document content writes wake the embedding indexer through the app reference',
    async ({ db }) => {
      await withTempConfig({}, async () => {
        const owner = await seedUser(db, 'owner');
        const doc = await seedDocument(db, owner, { content_text: '# Page\n\nBefore' });
        const wake = vi.fn();
        const app = {
          get: (key: string) => (key === 'knowledgeEmbeddingIndexer' ? { wake } : undefined),
        } as never;
        const service = new KnowledgeDocumentsService(db, app);

        await service.patch(doc.document_id, { content_text: '# Page\n\nAfter' }, params(owner));

        expect(wake).toHaveBeenCalledTimes(1);
      });
    }
  );
});

describe('KnowledgeSearchService and KnowledgeVersionsService permissions', () => {
  dbTest(
    'applies draft lifecycle defaults in tree/list, search, and direct get',
    async ({ db }) => {
      const owner = await seedUser(db, 'owner');
      const other = await seedUser(db, 'other');
      const draftDoc = await seedDocument(db, owner, {
        status: 'draft',
        visibility: 'public',
        path: 'draft.md',
        content_text: 'draftneedle',
      });
      const publishedDoc = await seedDocument(db, owner, {
        status: 'published',
        visibility: 'public',
        path: 'published.md',
        content_text: 'draftneedle',
      });
      const documents = new KnowledgeDocumentsService(db);
      const search = new KnowledgeSearchService(db);

      const ownerTree = await documents.find(params(owner, { archived: false }));
      expect(ownerTree.map((doc) => doc.document_id)).toContain(draftDoc.document_id);

      const ownerTreeWithIndexing = await documents.find(
        params(owner, { archived: false, include_indexing: true })
      );
      expect(
        ownerTreeWithIndexing.find((doc) => doc.document_id === draftDoc.document_id)
          ?.indexing_status
      ).toMatchObject({ state: 'not_configured', total_units: 1 });

      const otherTree = await documents.find(params(other, { archived: false }));
      expect(otherTree.map((doc) => doc.document_id)).not.toContain(draftDoc.document_id);
      expect(otherTree.map((doc) => doc.document_id)).toContain(publishedDoc.document_id);

      const ownerSearch = await search.find(params(owner, { q: 'draftneedle' }));
      expect(ownerSearch.map((result) => result.document.document_id)).toContain(
        draftDoc.document_id
      );

      const ownerSearchWithIndexing = await search.find(
        params(owner, { q: 'draftneedle', include_indexing: true })
      );
      expect(
        ownerSearchWithIndexing.find(
          (result) => result.document.document_id === draftDoc.document_id
        )?.document.indexing_status
      ).toMatchObject({ state: 'not_configured', total_units: 1 });

      const otherSearch = await search.find(params(other, { q: 'draftneedle' }));
      expect(otherSearch.map((result) => result.document.document_id)).not.toContain(
        draftDoc.document_id
      );
      expect(otherSearch.map((result) => result.document.document_id)).toContain(
        publishedDoc.document_id
      );

      await expect(documents.get(draftDoc.document_id, params(other))).resolves.toMatchObject({
        document_id: draftDoc.document_id,
        status: 'draft',
      });

      const versions = new KnowledgeVersionsService(db);
      const draftHistoryByUri = await versions.find(
        params(other, { uri: draftDoc.uri, include_content: true })
      );
      expect(draftHistoryByUri[0]).toMatchObject({
        document_id: draftDoc.document_id,
        content_text: 'draftneedle',
      });

      const optedIn = await search.find(
        params(other, { q: 'draftneedle', include_other_user_drafts: true })
      );
      expect(optedIn.map((result) => result.document.document_id)).toContain(draftDoc.document_id);
    }
  );

  dbTest('scopes search results and ignores non-admin include_archived', async ({ db }) => {
    const owner = await seedUser(db, 'owner');
    const other = await seedUser(db, 'other');
    const admin = await seedUser(db, 'admin', ROLES.ADMIN);
    const publicDoc = await seedDocument(db, owner, {
      visibility: 'public',
      path: 'public.md',
      content_text: 'sharedterm public',
    });
    const privateDoc = await seedDocument(db, owner, {
      visibility: 'private',
      path: 'private.md',
      content_text: 'sharedterm private',
    });
    const archivedDoc = await seedDocument(db, owner, {
      visibility: 'public',
      path: 'archived.md',
      content_text: 'archivedterm',
    });
    await new KnowledgeDocumentRepository(db).delete(archivedDoc.document_id);

    const search = new KnowledgeSearchService(db);
    const otherResults = await search.find(params(other, { q: 'sharedterm' }));
    expect(otherResults.map((result) => result.document.document_id)).toEqual([
      publicDoc.document_id,
    ]);

    const ownerResults = await search.find(params(owner, { q: 'sharedterm' }));
    expect(new Set(ownerResults.map((result) => result.document.document_id))).toEqual(
      new Set([publicDoc.document_id, privateDoc.document_id])
    );

    expect(await search.find(params(other, { q: 'archivedterm', include_archived: true }))).toEqual(
      []
    );
    expect(
      (await search.find(params(admin, { q: 'archivedterm', include_archived: true })))[0].document
        .document_id
    ).toBe(archivedDoc.document_id);
  });

  dbTest(
    'hides private and archived history while honoring include_content and limit',
    async ({ db }) => {
      const owner = await seedUser(db, 'owner');
      const other = await seedUser(db, 'other');
      const doc = await seedDocument(db, owner, { visibility: 'private', content_text: 'v1' });
      await new KnowledgeDocumentRepository(db).update(doc.document_id, {
        content_text: 'v2',
        updated_by: owner.user_id as UserID,
      });
      const versions = new KnowledgeVersionsService(db);

      await expect(
        versions.find(params(other, { document_id: doc.document_id }))
      ).rejects.toBeInstanceOf(Forbidden);

      const ownerHistory = await versions.find(
        params(owner, { document_id: doc.document_id, include_content: true, $limit: 1 })
      );
      expect(ownerHistory).toHaveLength(1);
      expect(ownerHistory[0].content_text).toBe('v2');

      const redacted = await versions.find(params(owner, { document_id: doc.document_id }));
      expect(redacted[0].content_text).toBeNull();

      await new KnowledgeDocumentRepository(db).delete(doc.document_id);
      expect(await versions.find(params(owner, { document_id: doc.document_id }))).toEqual([]);
    }
  );

  dbTest(
    'requires namespace read for version history even when document is public',
    async ({ db }) => {
      const owner = await seedUser(db, 'owner');
      const other = await seedUser(db, 'other');
      const namespaces = new KnowledgeNamespaceRepository(db);
      const namespace = await namespaces.create({
        slug: 'history-closed-namespace',
        display_name: 'History Closed Namespace',
        owner_user_id: owner.user_id as UserID,
        others_can: 'none',
      });
      const doc = await new KnowledgeDocumentRepository(db).create({
        namespace_id: namespace.namespace_id,
        path: 'history.md',
        title: 'History',
        visibility: 'public',
        content_text: 'history body',
        created_by: owner.user_id as UserID,
      });
      const versions = new KnowledgeVersionsService(db);

      await expect(
        versions.find(params(other, { document_id: doc.document_id }))
      ).rejects.toBeInstanceOf(Forbidden);

      await namespaces.upsertNamespaceAclEntry({
        namespace_id: namespace.namespace_id,
        subject_type: 'user',
        subject_id: other.user_id,
        permission: 'read',
      });
      await expect(
        versions.find(params(other, { document_id: doc.document_id }))
      ).resolves.toHaveLength(1);
    }
  );
});

describe('KnowledgeGraphService permissions', () => {
  dbTest('resolves draft document refs by URI and path for graph access', async ({ db }) => {
    const owner = await seedUser(db, 'owner');
    const draftDoc = await seedDocument(db, owner, {
      status: 'draft',
      visibility: 'public',
      path: 'draft-graph.md',
    });
    const parsed = parseKnowledgeUri(draftDoc.uri);
    if (!parsed) throw new Error('Expected seeded draft document to have a KB URI');
    const graph = new KnowledgeGraphService(db);

    await expect(
      graph.link(
        {
          source: { namespace: parsed.namespace_slug, path: parsed.path },
          target: { externalUri: 'https://example.com/draft-ref', label: 'Draft ref' },
          edge_type: 'references',
        },
        params(owner)
      )
    ).resolves.toMatchObject({ edge_type: 'references' });

    await expect(
      graph.neighbors({ node: { uri: draftDoc.uri }, direction: 'both' }, params(owner))
    ).resolves.toMatchObject({
      center: {
        uri: draftDoc.uri,
      },
    });
  });

  dbTest('prevents linking to private documents the caller cannot write', async ({ db }) => {
    const owner = await seedUser(db, 'owner');
    const other = await seedUser(db, 'other');
    const privateDoc = await seedDocument(db, owner, { visibility: 'private' });
    const graph = new KnowledgeGraphService(db);

    await expect(
      graph.link(
        {
          source: { documentId: privateDoc.document_id },
          target: { externalUri: 'https://example.com/ext', label: 'External' },
          edge_type: 'references',
        },
        params(other)
      )
    ).rejects.toBeInstanceOf(Forbidden);
  });

  dbTest('requires namespace read/write for graph reads and links', async ({ db }) => {
    const owner = await seedUser(db, 'owner');
    const other = await seedUser(db, 'other');
    const namespaces = new KnowledgeNamespaceRepository(db);
    const namespace = await namespaces.create({
      slug: 'graph-closed-namespace',
      display_name: 'Graph Closed Namespace',
      owner_user_id: owner.user_id as UserID,
      others_can: 'none',
    });
    const doc = await new KnowledgeDocumentRepository(db).create({
      namespace_id: namespace.namespace_id,
      path: 'graph.md',
      title: 'Graph',
      visibility: 'public',
      edit_policy: 'public',
      content_text: 'graph body',
      created_by: owner.user_id as UserID,
    });
    const graph = new KnowledgeGraphService(db);

    expect(
      await graph.namespaceGraph({ namespace_id: namespace.namespace_id }, params(other))
    ).toEqual({
      namespace_id: null,
      nodes: [],
      edges: [],
    });

    await namespaces.upsertNamespaceAclEntry({
      namespace_id: namespace.namespace_id,
      subject_type: 'user',
      subject_id: other.user_id,
      permission: 'read',
    });
    const readableGraph = await graph.namespaceGraph(
      { namespace_id: namespace.namespace_id },
      params(other)
    );
    expect(readableGraph.nodes.map((node) => node.document_id)).toEqual([doc.document_id]);
    await expect(
      graph.link(
        {
          source: { documentId: doc.document_id },
          target: { externalUri: 'https://example.com/no-write', label: 'No write' },
          edge_type: 'references',
        },
        params(other)
      )
    ).rejects.toBeInstanceOf(Forbidden);

    await namespaces.upsertNamespaceAclEntry({
      namespace_id: namespace.namespace_id,
      subject_type: 'user',
      subject_id: other.user_id,
      permission: 'write',
    });
    await expect(
      graph.link(
        {
          source: { documentId: doc.document_id },
          target: { externalUri: 'https://example.com/write', label: 'Write' },
          edge_type: 'references',
        },
        params(other)
      )
    ).resolves.toMatchObject({ edge_type: 'references' });
  });

  dbTest('filters unreadable private neighbors from public graph queries', async ({ db }) => {
    const owner = await seedUser(db, 'owner');
    const other = await seedUser(db, 'other');
    const publicDoc = await seedDocument(db, owner, {
      visibility: 'public',
      edit_policy: 'public',
      path: 'public.md',
    });
    const privateDoc = await seedDocument(db, owner, {
      visibility: 'private',
      path: 'private.md',
    });
    const graph = new KnowledgeGraphService(db);

    await graph.link(
      {
        source: { documentId: publicDoc.document_id },
        target: { documentId: privateDoc.document_id },
        edge_type: 'references',
      },
      params(owner)
    );

    const result = await graph.neighbors(
      { node: { documentId: publicDoc.document_id }, direction: 'both' },
      params(other)
    );
    expect(result.center.document_id).toBe(publicDoc.document_id);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });
});
