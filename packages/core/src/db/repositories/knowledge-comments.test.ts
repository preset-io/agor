import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { KnowledgeDocument, UserID } from '../../types';
import type { Database } from '../client';
import { dbTest } from '../test-helpers';
import { EntityNotFoundError, RepositoryError } from './base';
import { KnowledgeDocumentRepository, KnowledgeNamespaceRepository } from './knowledge';
import { KnowledgeDocumentCommentsRepository } from './knowledge-comments';
import { UsersRepository } from './users';

async function seedUser(db: Database, label: string) {
  const users = new UsersRepository(db);
  return users.create({
    user_id: generateId() as UserID,
    email: `${label}-${generateId()}@test.local`,
    name: label,
  });
}

async function seedDocument(db: Database, slug: string): Promise<KnowledgeDocument> {
  const namespace = await new KnowledgeNamespaceRepository(db).create({
    slug,
    display_name: slug,
  });
  return new KnowledgeDocumentRepository(db).create({
    namespace_id: namespace.namespace_id,
    path: 'guides/intro.md',
    title: 'Intro',
    content_text: '# Intro\n\n## Setup\n\nHello',
  });
}

describe('KnowledgeDocumentCommentsRepository', () => {
  dbTest('materializes preview and defaults on create', async ({ db }) => {
    const author = await seedUser(db, 'author');
    const document = await seedDocument(db, 'create-defaults');
    const repo = new KnowledgeDocumentCommentsRepository(db);

    const created = await repo.create({
      document_id: document.document_id,
      created_by: author.user_id as UserID,
      content: 'x'.repeat(250),
      anchor_slug: 'setup',
      anchor_label: 'Setup',
    });

    expect(created.comment_id).toBeDefined();
    expect(created.content_preview).toBe(`${'x'.repeat(200)}...`);
    expect(created.resolved).toBe(false);
    expect(created.edited).toBe(false);
    expect(created.reactions).toEqual([]);
    expect(created.parent_comment_id).toBeUndefined();
    expect(created.anchor_slug).toBe('setup');
  });

  dbTest('stores document-level threads with a null anchor', async ({ db }) => {
    const author = await seedUser(db, 'author');
    const document = await seedDocument(db, 'doc-level');
    const repo = new KnowledgeDocumentCommentsRepository(db);

    const created = await repo.create({
      document_id: document.document_id,
      created_by: author.user_id as UserID,
      content: 'Applies to the whole page',
      anchor_slug: null,
      anchor_label: null,
    });

    expect(created.anchor_slug).toBeNull();
    expect(created.anchor_label).toBeNull();
  });

  dbTest('rejects comments without a document, author, or content', async ({ db }) => {
    const author = await seedUser(db, 'author');
    const document = await seedDocument(db, 'validation');
    const repo = new KnowledgeDocumentCommentsRepository(db);

    await expect(
      repo.create({ created_by: author.user_id as UserID, content: 'orphan' })
    ).rejects.toThrow(RepositoryError);
    await expect(
      repo.create({ document_id: document.document_id, content: 'anonymous' })
    ).rejects.toThrow(RepositoryError);
    await expect(
      repo.create({
        document_id: document.document_id,
        created_by: author.user_id as UserID,
        content: '   ',
      })
    ).rejects.toThrow(RepositoryError);
  });

  dbTest('scopes and filters listings per document, oldest first', async ({ db }) => {
    const author = await seedUser(db, 'author');
    const other = await seedUser(db, 'other');
    const document = await seedDocument(db, 'listing-a');
    const otherDocument = await seedDocument(db, 'listing-b');
    const repo = new KnowledgeDocumentCommentsRepository(db);

    const first = await repo.create({
      document_id: document.document_id,
      created_by: author.user_id as UserID,
      content: 'first',
      created_at: new Date(1_000),
    });
    const second = await repo.create({
      document_id: document.document_id,
      created_by: other.user_id as UserID,
      content: 'second',
      created_at: new Date(2_000),
    });
    await repo.resolve(second.comment_id);
    await repo.create({
      document_id: otherDocument.document_id,
      created_by: author.user_id as UserID,
      content: 'elsewhere',
    });

    const forDocument = await repo.findAll({ document_id: document.document_id });
    expect(forDocument.map((c) => c.content)).toEqual(['first', 'second']);
    expect(await repo.count({ document_id: document.document_id })).toBe(2);

    const unresolved = await repo.findAll({
      document_id: document.document_id,
      resolved: false,
    });
    expect(unresolved.map((c) => c.comment_id)).toEqual([first.comment_id]);

    const byAuthor = await repo.findAll({
      document_id: document.document_id,
      created_by: other.user_id,
    });
    expect(byAuthor.map((c) => c.comment_id)).toEqual([second.comment_id]);
  });

  dbTest('flags edits and refreshes the preview on content change', async ({ db }) => {
    const author = await seedUser(db, 'author');
    const document = await seedDocument(db, 'editing');
    const repo = new KnowledgeDocumentCommentsRepository(db);
    const created = await repo.create({
      document_id: document.document_id,
      created_by: author.user_id as UserID,
      content: 'original',
    });

    const resolved = await repo.resolve(created.comment_id);
    expect(resolved.resolved).toBe(true);
    expect(resolved.edited).toBe(false);

    const edited = await repo.update(created.comment_id, { content: 'revised' });
    expect(edited.content).toBe('revised');
    expect(edited.content_preview).toBe('revised');
    expect(edited.edited).toBe(true);
    expect(edited.updated_at).toBeInstanceOf(Date);

    const unresolved = await repo.unresolve(created.comment_id);
    expect(unresolved.resolved).toBe(false);
    expect(unresolved.edited).toBe(true);
  });

  dbTest('replies inherit document and anchor, and cannot nest', async ({ db }) => {
    const author = await seedUser(db, 'author');
    const replier = await seedUser(db, 'replier');
    const document = await seedDocument(db, 'threading');
    const repo = new KnowledgeDocumentCommentsRepository(db);
    const root = await repo.create({
      document_id: document.document_id,
      created_by: author.user_id as UserID,
      content: 'root',
      anchor_slug: 'setup',
      anchor_label: 'Setup',
    });

    const reply = await repo.createReply(root.comment_id, {
      created_by: replier.user_id as UserID,
      content: 'reply',
    });

    expect(reply.parent_comment_id).toBe(root.comment_id);
    expect(reply.document_id).toBe(document.document_id);
    expect(reply.anchor_slug).toBe('setup');
    expect(reply.anchor_label).toBe('Setup');

    await expect(
      repo.createReply(reply.comment_id, {
        created_by: replier.user_id as UserID,
        content: 'nested',
      })
    ).rejects.toThrow(RepositoryError);
    await expect(
      repo.createReply(generateId(), {
        created_by: replier.user_id as UserID,
        content: 'ghost parent',
      })
    ).rejects.toThrow(EntityNotFoundError);
  });

  dbTest('deleting a thread root removes its replies', async ({ db }) => {
    const author = await seedUser(db, 'author');
    const document = await seedDocument(db, 'cascade');
    const repo = new KnowledgeDocumentCommentsRepository(db);
    const root = await repo.create({
      document_id: document.document_id,
      created_by: author.user_id as UserID,
      content: 'root',
    });
    const survivor = await repo.create({
      document_id: document.document_id,
      created_by: author.user_id as UserID,
      content: 'unrelated',
    });
    await repo.createReply(root.comment_id, {
      created_by: author.user_id as UserID,
      content: 'reply',
    });

    await repo.delete(root.comment_id);

    const remaining = await repo.findAll({ document_id: document.document_id });
    expect(remaining.map((c) => c.comment_id)).toEqual([survivor.comment_id]);
    await expect(repo.delete(root.comment_id)).rejects.toThrow(EntityNotFoundError);
  });

  dbTest('toggles a reaction per user and emoji', async ({ db }) => {
    const author = await seedUser(db, 'author');
    const other = await seedUser(db, 'other');
    const document = await seedDocument(db, 'reactions');
    const repo = new KnowledgeDocumentCommentsRepository(db);
    const created = await repo.create({
      document_id: document.document_id,
      created_by: author.user_id as UserID,
      content: 'react to me',
    });

    await repo.toggleReaction(created.comment_id, author.user_id, '👍');
    const both = await repo.toggleReaction(created.comment_id, other.user_id, '👍');
    expect(both.reactions).toEqual([
      { user_id: author.user_id, emoji: '👍' },
      { user_id: other.user_id, emoji: '👍' },
    ]);

    const removed = await repo.toggleReaction(created.comment_id, author.user_id, '👍');
    expect(removed.reactions).toEqual([{ user_id: other.user_id, emoji: '👍' }]);
    expect(removed.edited).toBe(false);
  });

  // Documents archive rather than hard-delete, so a thread must survive an
  // archive/unarchive round trip instead of being cascaded away.
  dbTest('keeps threads when the document is archived', async ({ db }) => {
    const author = await seedUser(db, 'author');
    const document = await seedDocument(db, 'document-archive');
    const repo = new KnowledgeDocumentCommentsRepository(db);
    await repo.create({
      document_id: document.document_id,
      created_by: author.user_id as UserID,
      content: 'survives archiving',
    });

    await new KnowledgeDocumentRepository(db).delete(document.document_id);

    expect(await repo.count({ document_id: document.document_id })).toBe(1);
  });

  dbTest('resolves short ids and returns null for unknown ids', async ({ db }) => {
    const author = await seedUser(db, 'author');
    const document = await seedDocument(db, 'short-ids');
    const repo = new KnowledgeDocumentCommentsRepository(db);
    const created = await repo.create({
      document_id: document.document_id,
      created_by: author.user_id as UserID,
      content: 'find me',
    });

    const found = await repo.findById(created.comment_id.slice(0, 8));
    expect(found?.comment_id).toBe(created.comment_id);
    expect(await repo.findById(generateId())).toBeNull();
  });
});
