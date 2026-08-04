/**
 * KnowledgeDocumentCommentsService tests
 *
 * Focus: the namespace-ACL gate. KB comments deliberately do not reuse board
 * RBAC, so the read/write boundary is the part worth pinning down.
 */

import { PAGINATION } from '@agor/core/config';
import {
  type Database,
  generateId,
  KnowledgeDocumentRepository,
  KnowledgeNamespaceRepository,
  UsersRepository,
} from '@agor/core/db';
import type { KnowledgeDocument, User, UserID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import {
  type KnowledgeDocumentCommentParams,
  KnowledgeDocumentCommentsService,
} from './knowledge-document-comments';

async function seedUser(db: Database, label: string, role: User['role'] = 'member') {
  return new UsersRepository(db).create({
    user_id: generateId() as UserID,
    email: `${label}-${generateId()}@test.local`,
    name: label,
    role,
  });
}

/** A namespace nobody can touch without an explicit grant. */
async function seedPrivateDocument(db: Database, slug: string): Promise<KnowledgeDocument> {
  const namespace = await new KnowledgeNamespaceRepository(db).create({
    slug,
    display_name: slug,
    others_can: 'none',
  });
  return new KnowledgeDocumentRepository(db).create({
    namespace_id: namespace.namespace_id,
    path: 'guides/intro.md',
    title: 'Intro',
    content_text: '# Intro\n\n## Setup\n\nHello',
  });
}

function paramsFor(user: User, query?: Record<string, unknown>): KnowledgeDocumentCommentParams {
  return { user, query } as unknown as KnowledgeDocumentCommentParams;
}

async function grant(
  db: Database,
  document: KnowledgeDocument,
  user: User,
  permission: 'read' | 'write'
) {
  await new KnowledgeNamespaceRepository(db).upsertNamespaceAclEntry({
    namespace_id: document.namespace_id,
    subject_type: 'user',
    subject_id: user.user_id,
    permission,
  });
}

describe('KnowledgeDocumentCommentsService', () => {
  dbTest('requires namespace write access to comment', async ({ db }) => {
    const service = new KnowledgeDocumentCommentsService(db);
    const document = await seedPrivateDocument(db, 'acl-write');
    const reader = await seedUser(db, 'reader');
    const writer = await seedUser(db, 'writer');
    await grant(db, document, reader, 'read');
    await grant(db, document, writer, 'write');

    await expect(
      service.create(
        { document_id: document.document_id, content: 'read-only attempt' },
        paramsFor(reader)
      )
    ).rejects.toThrow(/write access/i);

    const created = await service.create(
      { document_id: document.document_id, content: 'allowed', anchor_slug: 'setup' },
      paramsFor(writer)
    );
    expect(created.created_by).toBe(writer.user_id);
    expect(created.anchor_slug).toBe('setup');
  });

  dbTest('hides threads from users without document read access', async ({ db }) => {
    const service = new KnowledgeDocumentCommentsService(db);
    const document = await seedPrivateDocument(db, 'acl-read');
    const writer = await seedUser(db, 'writer');
    const outsider = await seedUser(db, 'outsider');
    const reader = await seedUser(db, 'reader');
    await grant(db, document, writer, 'write');
    await grant(db, document, reader, 'read');
    await service.create(
      { document_id: document.document_id, content: 'internal note' },
      paramsFor(writer)
    );

    await expect(
      service.find(paramsFor(outsider, { document_id: document.document_id }))
    ).rejects.toThrow(/permission/i);

    const visible = await service.find(paramsFor(reader, { document_id: document.document_id }));
    expect(visible.data.map((c) => c.content)).toEqual(['internal note']);
    expect(visible.total).toBe(1);
  });

  dbTest('scopes listing to one document and requires document_id', async ({ db }) => {
    const service = new KnowledgeDocumentCommentsService(db);
    const admin = await seedUser(db, 'admin', 'admin');
    const first = await seedPrivateDocument(db, 'scope-a');
    const second = await seedPrivateDocument(db, 'scope-b');
    await service.create({ document_id: first.document_id, content: 'first' }, paramsFor(admin));
    await service.create({ document_id: second.document_id, content: 'second' }, paramsFor(admin));

    await expect(service.find(paramsFor(admin, {}))).rejects.toThrow(/document_id is required/i);

    const listed = await service.find(paramsFor(admin, { document_id: first.document_id }));
    expect(listed.data.map((c) => c.content)).toEqual(['first']);
  });

  dbTest('lets any writer resolve, but only the author edit or delete', async ({ db }) => {
    const service = new KnowledgeDocumentCommentsService(db);
    const document = await seedPrivateDocument(db, 'moderation');
    const author = await seedUser(db, 'author');
    const teammate = await seedUser(db, 'teammate');
    await grant(db, document, author, 'write');
    await grant(db, document, teammate, 'write');
    const comment = await service.create(
      { document_id: document.document_id, content: 'needs a decision' },
      paramsFor(author)
    );

    const resolved = await service.patch(
      comment.comment_id,
      { resolved: true },
      paramsFor(teammate)
    );
    expect(resolved.resolved).toBe(true);

    await expect(
      service.patch(comment.comment_id, { content: 'hijacked' }, paramsFor(teammate))
    ).rejects.toThrow(/author/i);
    await expect(service.remove(comment.comment_id, paramsFor(teammate))).rejects.toThrow(
      /author/i
    );

    const edited = await service.patch(
      comment.comment_id,
      { content: 'clarified' },
      paramsFor(author)
    );
    expect(edited.content).toBe('clarified');
    expect(edited.edited).toBe(true);

    await service.remove(comment.comment_id, paramsFor(author));
    const remaining = await service.find(paramsFor(author, { document_id: document.document_id }));
    expect(remaining.total).toBe(0);
  });

  dbTest('creates replies from a parent and toggles reactions', async ({ db }) => {
    const service = new KnowledgeDocumentCommentsService(db);
    const document = await seedPrivateDocument(db, 'threading');
    const author = await seedUser(db, 'author');
    const teammate = await seedUser(db, 'teammate');
    await grant(db, document, author, 'write');
    await grant(db, document, teammate, 'write');
    const root = await service.create(
      { document_id: document.document_id, content: 'root', anchor_slug: 'setup' },
      paramsFor(author)
    );

    const reply = await service.create(
      { parent_comment_id: root.comment_id, content: 'reply' },
      paramsFor(teammate)
    );
    expect(reply.parent_comment_id).toBe(root.comment_id);
    expect(reply.anchor_slug).toBe('setup');
    expect(reply.created_by).toBe(teammate.user_id);

    const reacted = await service.toggleReaction(
      { comment_id: root.comment_id, emoji: '👍' },
      paramsFor(teammate)
    );
    expect(reacted.reactions).toEqual([{ user_id: teammate.user_id, emoji: '👍' }]);

    const unreacted = await service.toggleReaction(
      { comment_id: root.comment_id, emoji: '👍' },
      paramsFor(teammate)
    );
    expect(unreacted.reactions).toEqual([]);
  });

  dbTest('gates get() on the comment’s own document', async ({ db }) => {
    const service = new KnowledgeDocumentCommentsService(db);
    const document = await seedPrivateDocument(db, 'get-gate');
    const writer = await seedUser(db, 'writer');
    const outsider = await seedUser(db, 'outsider');
    await grant(db, document, writer, 'write');
    const comment = await service.create(
      { document_id: document.document_id, content: 'private note' },
      paramsFor(writer)
    );

    await expect(service.get(comment.comment_id, paramsFor(outsider))).rejects.toThrow(
      /permission/i
    );
    expect((await service.get(comment.comment_id, paramsFor(writer))).content).toBe('private note');
  });

  // A reply must inherit its parent's document, never a caller-supplied one.
  dbTest('ignores a document_id sent alongside parent_comment_id', async ({ db }) => {
    const service = new KnowledgeDocumentCommentsService(db);
    const admin = await seedUser(db, 'admin', 'admin');
    const document = await seedPrivateDocument(db, 'reply-scope');
    const elsewhere = await seedPrivateDocument(db, 'reply-elsewhere');
    const root = await service.create(
      { document_id: document.document_id, content: 'root' },
      paramsFor(admin)
    );

    const reply = await service.create(
      {
        parent_comment_id: root.comment_id,
        document_id: elsewhere.document_id,
        content: 'reply',
      },
      paramsFor(admin)
    );

    expect(reply.document_id).toBe(document.document_id);
  });

  dbTest('rejects empty content and out-of-range pagination', async ({ db }) => {
    const service = new KnowledgeDocumentCommentsService(db);
    const admin = await seedUser(db, 'admin', 'admin');
    const document = await seedPrivateDocument(db, 'validation');
    await service.create({ document_id: document.document_id, content: 'real' }, paramsFor(admin));

    await expect(
      service.create({ document_id: document.document_id, content: '   ' }, paramsFor(admin))
    ).rejects.toThrow(/content is required/i);

    const listed = await service.find(
      paramsFor(admin, { document_id: document.document_id, $limit: 10_000_000, $skip: -5 })
    );
    expect(listed.limit).toBe(PAGINATION.MAX_LIMIT);
    expect(listed.skip).toBe(0);
    expect(listed.data).toHaveLength(1);
  });

  dbTest('lists by short document id', async ({ db }) => {
    const service = new KnowledgeDocumentCommentsService(db);
    const admin = await seedUser(db, 'admin', 'admin');
    const document = await seedPrivateDocument(db, 'short-id');
    await service.create({ document_id: document.document_id, content: 'found' }, paramsFor(admin));

    const listed = await service.find(
      paramsFor(admin, { document_id: document.document_id.slice(0, 8) })
    );
    expect(listed.data.map((c) => c.content)).toEqual(['found']);
  });

  dbTest('refuses to comment on an archived document', async ({ db }) => {
    const service = new KnowledgeDocumentCommentsService(db);
    const admin = await seedUser(db, 'admin', 'admin');
    const document = await seedPrivateDocument(db, 'archived');
    await new KnowledgeDocumentRepository(db).delete(document.document_id);

    await expect(
      service.create({ document_id: document.document_id, content: 'too late' }, paramsFor(admin))
    ).rejects.toThrow(/not found/i);
  });
});
