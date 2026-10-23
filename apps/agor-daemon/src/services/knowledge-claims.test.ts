import {
  createTenantScopedDatabaseProxy,
  eq,
  generateId,
  KnowledgeDocumentRepository,
  KnowledgeNamespaceRepository,
  kbDocumentVersions,
  select,
  UsersRepository,
} from '@agor/core/db';
import { BadRequest, Conflict, Forbidden } from '@agor/core/feathers';
import { expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { KnowledgeDocumentsService } from './knowledge-documents.js';

dbTest(
  'competing absent-document claims have one winner and one immutable version; retries never overwrite',
  async ({ db }) => {
    const owner = await new UsersRepository(db).create({
      email: `${generateId()}@claims.test`,
      role: 'member',
    });
    const namespace = await new KnowledgeNamespaceRepository(db).create({
      slug: `claims-${generateId()}`,
      owner_user_id: owner.user_id,
      visibility_default: 'private',
      others_can: 'none',
    });
    const serviceDb = createTenantScopedDatabaseProxy(db, { requireScope: false });
    const a = new KnowledgeDocumentsService(serviceDb);
    const b = new KnowledgeDocumentsService(serviceDb);
    const input = {
      namespace_slug: namespace.slug,
      path: 'tasks/stable.md',
      visibility: 'private' as const,
      edit_policy: 'owner' as const,
      status: 'draft' as const,
    };
    const attempts = await Promise.allSettled([
      a.claimDocument({ ...input, content_text: 'candidate A' }, { user: owner }),
      b.claimDocument({ ...input, content_text: 'candidate B' }, { user: owner }),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(Conflict);
    const winner = await new KnowledgeDocumentRepository(db).findByNamespaceAndPath(
      namespace.namespace_id,
      input.path
    );
    expect(winner).toMatchObject({
      visibility: 'private',
      edit_policy: 'owner',
      created_by: owner.user_id,
    });
    const before = await select(db)
      .from(kbDocumentVersions)
      .where(eq(kbDocumentVersions.document_id, winner!.document_id))
      .all();
    expect(before).toHaveLength(1);
    expect(before[0].version_number).toBe(1);
    await expect(
      new KnowledgeDocumentsService(serviceDb).claimDocument(
        { ...input, content_text: 'retry after lost response' },
        { user: owner }
      )
    ).rejects.toBeInstanceOf(Conflict);
    expect(
      await select(db)
        .from(kbDocumentVersions)
        .where(eq(kbDocumentVersions.document_id, winner!.document_id))
        .all()
    ).toEqual(before);
    // Creation produces a stable ID; the normal current-version guard owns updates.
    await a.putDocument(
      {
        document_id: winner!.document_id,
        content_text: 'current update',
        expected_version: before[0].version_id,
        visibility: 'private',
        edit_policy: 'owner',
      },
      { user: owner }
    );
    await expect(
      b.putDocument(
        {
          document_id: winner!.document_id,
          content_text: 'stale update',
          expected_version: before[0].version_id,
          visibility: 'private',
          edit_policy: 'owner',
        },
        { user: owner }
      )
    ).rejects.toBeInstanceOf(Conflict);
  }
);

dbTest(
  'claims require creation input, preserve archived reservations and deny another owner',
  async ({ db }) => {
    const users = new UsersRepository(db);
    const owner = await users.create({ email: `${generateId()}@claims.test`, role: 'member' });
    const other = await users.create({ email: `${generateId()}@claims.test`, role: 'member' });
    const namespace = await new KnowledgeNamespaceRepository(db).create({
      slug: `claims-${generateId()}`,
      owner_user_id: owner.user_id,
      visibility_default: 'private',
      others_can: 'none',
    });
    const service = new KnowledgeDocumentsService(
      createTenantScopedDatabaseProxy(db, { requireScope: false })
    );
    const input = {
      namespace_slug: namespace.slug,
      path: 'tasks/reserved.md',
      content_text: 'private owner record',
      visibility: 'private' as const,
      edit_policy: 'owner' as const,
    };
    for (const invalid of [
      { ...input, content_text: undefined },
      { ...input, expected_version: 1 },
      { ...input, document_id: generateId() },
    ]) {
      await expect(service.claimDocument(invalid, { user: owner })).rejects.toBeInstanceOf(
        BadRequest
      );
    }
    await expect(service.claimDocument(input, { user: other })).rejects.toBeInstanceOf(Forbidden);
    const doc = await service.claimDocument(input, { user: owner });
    await service.patch(doc.document_id, { archived: true }, { user: owner });
    await expect(service.claimDocument(input, { user: owner })).rejects.toBeInstanceOf(Conflict);
    expect((await new KnowledgeDocumentRepository(db).findById(doc.document_id))?.archived).toBe(
      true
    );
  }
);
