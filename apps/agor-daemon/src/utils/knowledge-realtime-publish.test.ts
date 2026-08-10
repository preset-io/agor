import {
  type Database,
  GroupRepository,
  generateId,
  KnowledgeDocumentRepository,
  KnowledgeGraphRepository,
  KnowledgeNamespaceRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { KnowledgeDocument, User, UserID } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import {
  KNOWLEDGE_REALTIME_SUPPRESSED_CREATE_PATHS,
  resolveKnowledgeRealtimeUserIds,
} from './knowledge-realtime-publish';

async function seedUser(
  db: Database,
  label: string,
  role: User['role'] = ROLES.MEMBER
): Promise<User> {
  return new UsersRepository(db).create({
    user_id: generateId() as UserID,
    email: `${label}-${generateId()}@test.local`,
    name: label,
    role,
  }) as Promise<User>;
}

async function seedDocument(
  db: Database,
  owner: User,
  slug: string,
  visibility: KnowledgeDocument['visibility'] = 'public'
) {
  const namespace = await new KnowledgeNamespaceRepository(db).create({
    slug,
    display_name: slug,
    others_can: 'none',
  });
  const document = await new KnowledgeDocumentRepository(db).create({
    namespace_id: namespace.namespace_id,
    path: 'page.md',
    title: 'Page',
    visibility,
    status: 'published',
    edit_policy: 'owner',
    content_text: '# Page',
    created_by: owner.user_id,
  });
  return { namespace, document };
}

function appWithServices(services: Record<string, unknown> = {}): Application {
  return {
    service: vi.fn((path: string) => {
      const service = services[path];
      if (!service) throw new Error(`Unexpected service: ${path}`);
      return service;
    }),
  } as unknown as Application;
}

async function resolve(options: {
  db: Database;
  data: unknown;
  path: string;
  users: User[];
  event?: string;
  app?: Application;
}) {
  const app = options.app ?? appWithServices();
  return resolveKnowledgeRealtimeUserIds({
    app,
    db: options.db,
    data: options.data,
    context: { path: options.path, id: null, event: options.event ?? 'patched', app },
    userIds: options.users.map((user) => user.user_id),
  });
}

describe('Knowledge realtime ACL resolution', () => {
  for (const path of KNOWLEDGE_REALTIME_SUPPRESSED_CREATE_PATHS) {
    dbTest(`suppresses only the created event on ${path}`, async ({ db }) => {
      const current = await seedUser(db, `current-${path.replaceAll('/', '-')}`);
      const app = appWithServices();
      await expect(
        resolveKnowledgeRealtimeUserIds({
          app,
          db,
          data: {},
          context: { path, id: null, event: 'created', app },
          userIds: [current.user_id],
        })
      ).resolves.toEqual(new Set());
      await expect(
        resolveKnowledgeRealtimeUserIds({
          app,
          db,
          data: {},
          context: { path, id: null, event: 'patched', app },
          userIds: [current.user_id],
        })
      ).resolves.toEqual(new Set([current.user_id]));
    });
  }

  dbTest('reloads current roles and discards unresolved principals', async ({ db }) => {
    const owner = await seedUser(db, 'owner');
    const demoted = await seedUser(db, 'demoted', ROLES.ADMIN);
    const promoted = await seedUser(db, 'promoted');
    const removed = await seedUser(db, 'removed', ROLES.ADMIN);
    const { document } = await seedDocument(db, owner, 'current-principals');
    const users = new UsersRepository(db);

    await users.update(demoted.user_id, { role: ROLES.MEMBER });
    await users.update(promoted.user_id, { role: ROLES.ADMIN });
    await users.delete(removed.user_id);

    const app = appWithServices();
    const resolved = await resolveKnowledgeRealtimeUserIds({
      app,
      db,
      data: document,
      context: {
        path: 'kb/documents',
        id: document.document_id,
        event: 'patched',
        app,
      },
      userIds: [demoted.user_id, promoted.user_id, removed.user_id, generateId()],
    });

    expect(resolved).toEqual(new Set([promoted.user_id]));
  });

  dbTest(
    'rechecks direct and group access on every event and preserves admin access',
    async ({ db }) => {
      const owner = await seedUser(db, 'owner');
      const direct = await seedUser(db, 'direct');
      const grouped = await seedUser(db, 'grouped');
      const denied = await seedUser(db, 'denied');
      const admin = await seedUser(db, 'admin', ROLES.ADMIN);
      const superadmin = await seedUser(db, 'superadmin', ROLES.SUPERADMIN);
      const { namespace, document } = await seedDocument(db, owner, 'direct-group');
      const namespaces = new KnowledgeNamespaceRepository(db);
      const groups = new GroupRepository(db);
      const group = await groups.create({ name: 'Readers', slug: 'readers' });
      await groups.addMember(group.group_id, grouped.user_id);
      await namespaces.upsertNamespaceAclEntry({
        namespace_id: namespace.namespace_id,
        subject_type: 'user',
        subject_id: direct.user_id,
        permission: 'read',
      });
      await namespaces.upsertNamespaceAclEntry({
        namespace_id: namespace.namespace_id,
        subject_type: 'group',
        subject_id: group.group_id,
        permission: 'read',
      });

      const users = [direct, grouped, denied, admin, superadmin];
      expect(await resolve({ db, data: document, path: 'kb/documents', users })).toEqual(
        new Set([direct.user_id, grouped.user_id, admin.user_id, superadmin.user_id])
      );

      await namespaces.removeNamespaceAclEntry(namespace.namespace_id, 'user', direct.user_id);
      await groups.removeMember(group.group_id, grouped.user_id);
      expect(await resolve({ db, data: document, path: 'kb/documents', users })).toEqual(
        new Set([admin.user_id, superadmin.user_id])
      );
    }
  );

  dbTest(
    'applies the private-document creator overlay after namespace read access',
    async ({ db }) => {
      const owner = await seedUser(db, 'owner');
      const reader = await seedUser(db, 'reader');
      const admin = await seedUser(db, 'admin', ROLES.ADMIN);
      const { namespace, document } = await seedDocument(db, owner, 'private-overlay', 'private');
      const namespaces = new KnowledgeNamespaceRepository(db);
      for (const subject of [owner, reader]) {
        await namespaces.upsertNamespaceAclEntry({
          namespace_id: namespace.namespace_id,
          subject_type: 'user',
          subject_id: subject.user_id,
          permission: 'read',
        });
      }

      expect(
        await resolve({ db, data: document, path: 'kb/documents', users: [owner, reader, admin] })
      ).toEqual(new Set([owner.user_id, admin.user_id]));
    }
  );

  dbTest('requires graph readers to pass both document endpoints', async ({ db }) => {
    const owner = await seedUser(db, 'owner');
    const firstOnly = await seedUser(db, 'first-only');
    const both = await seedUser(db, 'both');
    const admin = await seedUser(db, 'admin', ROLES.ADMIN);
    const first = await seedDocument(db, owner, 'graph-first');
    const second = await seedDocument(db, owner, 'graph-second');
    const namespaces = new KnowledgeNamespaceRepository(db);
    for (const [namespaceId, reader] of [
      [first.namespace.namespace_id, firstOnly],
      [first.namespace.namespace_id, both],
      [second.namespace.namespace_id, both],
    ] as const) {
      await namespaces.upsertNamespaceAclEntry({
        namespace_id: namespaceId,
        subject_type: 'user',
        subject_id: reader.user_id,
        permission: 'read',
      });
    }
    const edge = await new KnowledgeGraphRepository(db).link({
      source: { document_id: first.document.document_id },
      target: { document_id: second.document.document_id },
      edge_type: 'references',
      created_by: owner.user_id,
    });

    expect(
      await resolve({ db, data: edge, path: 'kb/graph', users: [firstOnly, both, admin] })
    ).toEqual(new Set([both.user_id, admin.user_id]));
  });

  dbTest(
    'maps future comment replies to their parent document and fails closed when absent',
    async ({ db }) => {
      const owner = await seedUser(db, 'owner');
      const reader = await seedUser(db, 'reader');
      const { namespace, document } = await seedDocument(db, owner, 'comment-parent');
      await new KnowledgeNamespaceRepository(db).upsertNamespaceAclEntry({
        namespace_id: namespace.namespace_id,
        subject_type: 'user',
        subject_id: reader.user_id,
        permission: 'read',
      });
      const get = vi.fn(async (id: string) => {
        if (id === 'parent-present') return { document_id: document.document_id };
        throw new Error('missing parent');
      });
      const app = appWithServices({ 'kb/document-comments': { get } });

      expect(
        await resolve({
          db,
          app,
          data: { parent_comment_id: 'parent-present' },
          path: 'kb/document-comments',
          users: [reader],
        })
      ).toEqual(new Set([reader.user_id]));
      expect(
        await resolve({
          db,
          app,
          data: { parent_comment_id: 'parent-missing' },
          path: 'kb/document-comments',
          users: [reader],
        })
      ).toEqual(new Set());
    }
  );

  dbTest('fails closed for former namespace readers after namespace removal', async ({ db }) => {
    const owner = await seedUser(db, 'owner');
    const reader = await seedUser(db, 'reader');
    const admin = await seedUser(db, 'admin', ROLES.ADMIN);
    const { namespace } = await seedDocument(db, owner, 'removed-namespace');
    const namespaces = new KnowledgeNamespaceRepository(db);
    await namespaces.upsertNamespaceAclEntry({
      namespace_id: namespace.namespace_id,
      subject_type: 'user',
      subject_id: reader.user_id,
      permission: 'read',
    });
    await namespaces.delete(namespace.namespace_id);

    expect(
      await resolve({ db, data: namespace, path: 'kb/namespaces', users: [reader, admin] })
    ).toEqual(new Set([admin.user_id]));
  });
});
