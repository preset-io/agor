import {
  generateId,
  KnowledgeDocumentRepository,
  KnowledgeDocumentVersionRepository,
  KnowledgeNamespaceRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { KnowledgeDocument, User, UserID } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { createKnowledgeDocumentEditsService } from './knowledge-document-edits';
import { KnowledgeDocumentsService } from './knowledge-documents';

async function seedUser(
  db: Parameters<typeof dbTest>[0]['db'],
  label: string,
  role = ROLES.MEMBER
) {
  const users = new UsersRepository(db);
  return users.create({
    user_id: generateId() as UserID,
    email: `${label}-${Date.now()}-${Math.random()}@test.local`,
    name: label,
    role,
  }) as Promise<User>;
}

async function seedNamespace(db: Parameters<typeof dbTest>[0]['db']) {
  return new KnowledgeNamespaceRepository(db).create({
    slug: `kb-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    display_name: 'Test KB',
  });
}

async function seedDocument(
  db: Parameters<typeof dbTest>[0]['db'],
  owner: User,
  content = '# Title\nLine 1\nLine 2'
): Promise<KnowledgeDocument> {
  const namespace = await seedNamespace(db);
  const documents = new KnowledgeDocumentRepository(db);
  return documents.create({
    namespace_id: namespace.namespace_id,
    path: 'page.md',
    title: 'Page',
    visibility: 'public',
    edit_policy: 'owner',
    content_text: content,
    created_by: owner.user_id as UserID,
  });
}

function createServices(db: Parameters<typeof dbTest>[0]['db']) {
  const documentsService = new KnowledgeDocumentsService(db);
  const editsService = createKnowledgeDocumentEditsService(db, {} as Application, documentsService);
  return { documentsService, editsService };
}

describe('KnowledgeDocumentEditsService', () => {
  dbTest('returns dry-run diff and leaves document unchanged', async ({ db }) => {
    const owner = await seedUser(db, 'owner');
    const document = await seedDocument(db, owner);
    const { editsService } = createServices(db);

    const response = await editsService.create(
      {
        documentId: document.document_id,
        dryRun: true,
        ops: [
          {
            type: 'replace_line_range',
            startLine: 2,
            endLine: 2,
            replacement: 'Line 1 updated',
          },
        ],
        returnContent: 'full',
      },
      { user: owner }
    );

    expect(response.dryRun).toBe(true);
    expect(response.newVersion).toBeUndefined();
    expect(response.content).toContain('Line 1 updated');

    const versions = await new KnowledgeDocumentVersionRepository(db).findAll({
      document_id: document.document_id,
    });
    expect(versions).toHaveLength(1);
  });

  dbTest('applies edits and creates a new immutable version', async ({ db }) => {
    const owner = await seedUser(db, 'owner');
    const document = await seedDocument(db, owner);
    const { editsService } = createServices(db);

    const versionsRepo = new KnowledgeDocumentVersionRepository(db);
    const initialVersion = await versionsRepo.findLatestForDocument(document.document_id);
    expect(initialVersion).not.toBeNull();

    const response = await editsService.create(
      {
        documentId: document.document_id,
        expectedVersion: initialVersion?.version_number,
        changeSummary: 'Apply targeted edits',
        returnContent: 'full',
        ops: [
          {
            type: 'replace_line_range',
            startLine: 2,
            endLine: 2,
            replacement: 'Line 1 updated',
          },
          {
            type: 'insert_at_line',
            line: 3,
            position: 'after',
            content: 'New tail',
          },
        ],
      },
      { user: owner }
    );

    expect(response.dryRun).toBe(false);
    expect(response.newVersion?.version_number).toBe((initialVersion?.version_number ?? 0) + 1);
    expect(response.content).toContain('New tail');

    const finalVersion = await versionsRepo.findLatestForDocument(document.document_id);
    expect(finalVersion?.content_text).toContain('New tail');
  });

  dbTest('rejects edits when caller lacks permission', async ({ db }) => {
    const owner = await seedUser(db, 'owner');
    const other = await seedUser(db, 'other');
    const document = await seedDocument(db, owner);
    const { editsService } = createServices(db);

    await expect(
      editsService.create(
        {
          documentId: document.document_id,
          dryRun: true,
          ops: [
            { type: 'replace_line_range', startLine: 2, endLine: 2, replacement: 'Unauthorized' },
          ],
        },
        { user: other }
      )
    ).rejects.toThrowError();
  });

  dbTest('requires namespace write even for public-editable dry runs', async ({ db }) => {
    const owner = await seedUser(db, 'owner');
    const other = await seedUser(db, 'other');
    const namespaceRepo = new KnowledgeNamespaceRepository(db);
    const namespace = await namespaceRepo.create({
      slug: `closed-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      display_name: 'Closed KB',
      owner_user_id: owner.user_id as UserID,
      others_can: 'none',
    });
    const document = await new KnowledgeDocumentRepository(db).create({
      namespace_id: namespace.namespace_id,
      path: 'page.md',
      title: 'Page',
      visibility: 'public',
      edit_policy: 'public',
      content_text: '# Title\nLine 1',
      created_by: owner.user_id as UserID,
    });
    const { editsService } = createServices(db);

    await namespaceRepo.upsertNamespaceAclEntry({
      namespace_id: namespace.namespace_id,
      subject_type: 'user',
      subject_id: other.user_id,
      permission: 'read',
    });
    await expect(
      editsService.create(
        {
          documentId: document.document_id,
          dryRun: true,
          ops: [{ type: 'replace_line_range', startLine: 2, endLine: 2, replacement: 'No write' }],
        },
        { user: other }
      )
    ).rejects.toThrowError();

    await namespaceRepo.upsertNamespaceAclEntry({
      namespace_id: namespace.namespace_id,
      subject_type: 'user',
      subject_id: other.user_id,
      permission: 'write',
    });
    await expect(
      editsService.create(
        {
          documentId: document.document_id,
          dryRun: true,
          ops: [{ type: 'replace_line_range', startLine: 2, endLine: 2, replacement: 'Allowed' }],
        },
        { user: other }
      )
    ).resolves.toMatchObject({ dryRun: true });
  });
});
