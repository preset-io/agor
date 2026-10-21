import { createTenantScopedDatabaseProxy } from '@agor/core/db';
import type { BoardFileItem, BoardFilesPage, UserID } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers.js';
import { seedBoardFiles } from '../../test/board-files-fixture.js';
import { boardMetadataTestApp } from '../../test/board-metadata-app.js';
import type { RegisterHooksContext } from '../register-hooks.js';
import {
  type BoardFileCandidate,
  boardFileSessionTitle,
  pageBoardFiles,
  parseBoardFilesQuery,
  setupBoardFilesService,
} from './board-files.js';

const item = (id: string, name: string, made_at: string, kind: BoardFileItem['kind']) => ({
  item: {
    kind,
    id,
    name,
    made_at,
    created_at: made_at,
    made_by: { user_id: 'u' as UserID },
    source: 'board' as const,
  },
});

describe('pageBoardFiles', () => {
  const candidates: BoardFileCandidate[] = [
    item('a', 'Zeta chart', '2026-10-01T00:00:00.000Z', 'artifact'),
    {
      ...item('d', 'alpha notes', '2026-10-03T00:00:00.000Z', 'document'),
      searchText: ['qbr/x.md'],
    },
    item('p', 'Renewal app', '2026-10-02T00:00:00.000Z', 'app'),
    item('u', 'Order form.pdf', '2026-10-04T00:00:00.000Z', 'upload'),
  ];
  const ids = (page: BoardFilesPage) => page.data.map((entry) => entry.id);

  it('sorts by recent, name and type, then pages across sources', () => {
    const base = { q: '', limit: 50, skip: 0 };
    expect(ids(pageBoardFiles(candidates, { ...base, sort: 'recent' }))).toEqual([
      'u',
      'd',
      'p',
      'a',
    ]);
    expect(ids(pageBoardFiles(candidates, { ...base, sort: 'name' }))).toEqual([
      'd',
      'u',
      'p',
      'a',
    ]);
    // App and pull request, Artifact, Document, Upload.
    expect(ids(pageBoardFiles(candidates, { ...base, sort: 'type' }))).toEqual([
      'p',
      'a',
      'd',
      'u',
    ]);
    const second = pageBoardFiles(candidates, { ...base, sort: 'recent', limit: 2, skip: 2 });
    expect(second).toMatchObject({ total: 4, limit: 2, skip: 2 });
    expect(ids(second)).toEqual(['p', 'a']);
  });

  it('matches every search token against the name and the extra text', () => {
    const page = (q: string) =>
      ids(pageBoardFiles(candidates, { q, sort: 'recent', limit: 50, skip: 0 }));
    expect(page('QBR alpha')).toEqual(['d']);
    expect(page('chart zeta')).toEqual(['a']);
    expect(page('nothing')).toEqual([]);
  });
});

describe('parseBoardFilesQuery', () => {
  it('caps the page at 50 and validates kind, sort and include_archived', () => {
    expect(parseBoardFilesQuery({ $limit: '500', $skip: '-3' })).toMatchObject({
      limit: 50,
      skip: 0,
    });
    expect([...parseBoardFilesQuery({ kind: { $in: ['app', 'upload'] } }).kinds]).toEqual([
      'app',
      'upload',
    ]);
    expect(() => parseBoardFilesQuery({ kind: 'branch' })).toThrow(/kind/);
    expect(() => parseBoardFilesQuery({ sort: 'size' })).toThrow(/sort/);
    expect(() => parseBoardFilesQuery({ include_archived: 'true' })).toThrow(/session_id/);
    expect(
      parseBoardFilesQuery({ include_archived: 'true', session_id: 's' }).includeArchived
    ).toBe(true);
  });

  it('names a conversation by its title, else its first prompt line', () => {
    expect(boardFileSessionTitle({ title: 'QBR prep' })).toBe('QBR prep');
    expect(boardFileSessionTitle({ description: 'Draft the email\nmore' })).toBe('Draft the email');
    expect(boardFileSessionTitle({})).toBe('Conversation');
  });
});

async function filesServer(rawDb: Parameters<typeof seedBoardFiles>[0]) {
  const seed = await seedBoardFiles(rawDb);
  const db = createTenantScopedDatabaseProxy(rawDb, { label: 'board-files-test' });
  const server = await boardMetadataTestApp(
    db,
    {
      database: { dialect: 'sqlite' },
      multi_tenancy: { mode: 'static', static_tenant_id: 'board-files-test' },
      execution: {},
    } as RegisterHooksContext['config'],
    false,
    false,
    false,
    async (app) => setupBoardFilesService(app, db, { allowSuperadmin: false })
  );
  const list = async (userId: string, query = '') => {
    const response = await fetch(`${server.url}/boards/${seed.board.board_id}/files${query}`, {
      headers: server.headers(userId as UserID),
    });
    return { status: response.status, body: (await response.json()) as BoardFilesPage };
  };
  return { seed, server, list };
}

const byId = (page: BoardFilesPage) => new Map(page.data.map((entry) => [entry.id, entry]));

dbTest(
  'boards/:id/files lists only what each caller may see, with server-side filters and paging',
  async ({ db: rawDb }) => {
    const { seed, server, list } = await filesServer(rawDb);
    try {
      // The owner sees their private artifact, the hidden branch and their draft;
      // never archived items or memory documents.
      const owner = await list(seed.owner.user_id);
      expect(owner.status).toBe(200);
      const ownerItems = byId(owner.body);
      expect([...ownerItems.keys()].sort()).toEqual(
        [
          seed.artifacts.dashboard.artifact_id,
          seed.artifacts.privateDraft.artifact_id,
          seed.artifacts.hiddenBranchArtifact.artifact_id,
          seed.artifacts.fromSecret.artifact_id,
          seed.docs.talkingPoints.document_id,
          seed.docs.secretDoc.document_id,
          seed.docs.ownerDraft.document_id,
          seed.open.branch_id,
          seed.uploads.orderForm.ref,
          seed.uploads.secretUpload.ref,
          seed.uploads.viewerUpload.ref,
        ].sort()
      );
      expect(ownerItems.get(seed.artifacts.dashboard.artifact_id)).toMatchObject({
        kind: 'artifact',
        status: 'Live',
        made_by: { user_id: seed.owner.user_id },
        source: { session_id: seed.kickoff.session_id, title: 'Kickoff' },
      });
      expect(ownerItems.get(seed.open.branch_id)).toMatchObject({
        kind: 'app',
        name: 'open',
        status: 'Ready to review',
        pull_request_url: 'https://github.com/example/repo/pull/14',
        source: { session_id: seed.kickoff.session_id },
      });
      expect(ownerItems.get(seed.docs.ownerDraft.document_id)).toMatchObject({ status: 'Draft' });

      // A viewer: not the owner's private artifact or draft, nothing on the hidden
      // branch, and the hidden conversation reads as private. Uploads follow the
      // conversation, plus their own upload.
      const viewer = await list(seed.viewer.user_id);
      expect(viewer.status).toBe(200);
      const viewerItems = byId(viewer.body);
      expect([...viewerItems.keys()].sort()).toEqual(
        [
          seed.artifacts.dashboard.artifact_id,
          seed.artifacts.fromSecret.artifact_id,
          seed.docs.talkingPoints.document_id,
          seed.docs.secretDoc.document_id,
          seed.open.branch_id,
          seed.uploads.orderForm.ref,
          seed.uploads.viewerUpload.ref,
        ].sort()
      );
      expect(viewerItems.get(seed.artifacts.fromSecret.artifact_id)?.source).toBe('private');
      expect(viewerItems.get(seed.docs.secretDoc.document_id)?.source).toBe('private');
      expect(viewerItems.get(seed.uploads.viewerUpload.ref)).toMatchObject({
        source: 'private',
        made_by: { user_id: seed.viewer.user_id },
        mime_type: 'application/pdf',
        size_bytes: 2048,
      });
      expect(viewerItems.get(seed.uploads.orderForm.ref)?.source).toMatchObject({
        title: 'Kickoff',
      });

      // Type filter, search and sort run on the server.
      const docsOnly = await list(seed.viewer.user_id, '?kind=document');
      expect(docsOnly.body.data.every((entry) => entry.kind === 'document')).toBe(true);
      expect(docsOnly.body.total).toBe(2);
      const twoKinds = await list(seed.viewer.user_id, '?kind[$in][]=app&kind[$in][]=upload');
      expect(new Set(twoKinds.body.data.map((entry) => entry.kind))).toEqual(
        new Set(['app', 'upload'])
      );
      const search = await list(seed.viewer.user_id, '?q=quarterly');
      expect(search.body.data.map((entry) => entry.id)).toEqual([
        seed.artifacts.dashboard.artifact_id,
      ]);
      const byName = await list(seed.viewer.user_id, '?sort=name');
      const names = byName.body.data.map((entry) => entry.name);
      expect(names).toEqual(
        [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      );

      // Paging spans sources: two pages of 4 and 3 cover the same 7 items.
      const first = await list(seed.viewer.user_id, '?$limit=4&$skip=0');
      const second = await list(seed.viewer.user_id, '?$limit=4&$skip=4');
      expect(first.body).toMatchObject({ total: 7, limit: 4, skip: 0 });
      expect(second.body.data).toHaveLength(3);
      expect(new Set([...first.body.data, ...second.body.data].map((entry) => entry.id))).toEqual(
        new Set(viewerItems.keys())
      );

      // Archived items only for one conversation's work cards.
      const archivedWithoutSession = await list(seed.owner.user_id, '?include_archived=true');
      expect(archivedWithoutSession.status).toBe(400);
      const work = await list(
        seed.owner.user_id,
        `?session_id=${seed.kickoff.session_id}&include_archived=true&kind[$in][]=artifact&kind[$in][]=document`
      );
      const workItems = byId(work.body);
      expect(workItems.get(seed.artifacts.archivedChart.artifact_id)).toMatchObject({
        archived: true,
      });
      expect(workItems.get(seed.artifacts.dashboard.artifact_id)).toMatchObject({
        archived: false,
      });
      expect(workItems.has(seed.artifacts.fromSecret.artifact_id)).toBe(false);
      expect(workItems.has(seed.docs.memory.document_id)).toBe(false);

      // No board access: Forbidden, whatever the query.
      const outsider = await list(seed.outsider.user_id);
      expect(outsider.status).toBe(403);
    } finally {
      await server.close();
    }
  }
);

dbTest(
  'boards/:id/files?session_id= reads one visible session, whole, with the same item rules',
  async ({ db: rawDb }) => {
    const { seed, server, list } = await filesServer(rawDb);
    const work = (userId: string, sessionId: string, extra = '') =>
      list(userId, `?session_id=${sessionId}&include_archived=true${extra}`);
    try {
      // Only artifacts and documents, whatever the kinds asked for, and every one
      // of them: `$limit` does not page it.
      const owner = await work(seed.owner.user_id, seed.kickoff.session_id, '&$limit=1');
      expect(owner.status).toBe(200);
      expect(owner.body.total).toBe(owner.body.data.length);
      const ownerItems = byId(owner.body);
      expect([...ownerItems.keys()].sort()).toEqual(
        [
          seed.artifacts.dashboard.artifact_id,
          seed.artifacts.privateDraft.artifact_id,
          seed.artifacts.archivedChart.artifact_id,
          seed.docs.talkingPoints.document_id,
          seed.docs.ownerDraft.document_id,
        ].sort()
      );
      expect(ownerItems.get(seed.artifacts.archivedChart.artifact_id)).toMatchObject({
        archived: true,
        source: { session_id: seed.kickoff.session_id, title: 'Kickoff' },
        created_at: expect.any(String),
      });

      // The private rule and other people's drafts apply as on the board's list.
      const viewer = await work(seed.viewer.user_id, seed.kickoff.session_id);
      expect([...byId(viewer.body).keys()].sort()).toEqual(
        [
          seed.artifacts.dashboard.artifact_id,
          seed.artifacts.archivedChart.artifact_id,
          seed.docs.talkingPoints.document_id,
        ].sort()
      );

      // A session the caller cannot see, or that does not exist, has no work.
      const hidden = await work(seed.viewer.user_id, seed.secret.session_id);
      expect(hidden.status).toBe(200);
      expect(hidden.body).toMatchObject({ total: 0, data: [] });
      const missing = await work(seed.owner.user_id, '00000000-0000-7000-8000-000000000000');
      expect(missing.body).toMatchObject({ total: 0, data: [] });
      // Its owner sees it: two artifacts and a document.
      expect(await work(seed.owner.user_id, seed.secret.session_id)).toMatchObject({
        body: { total: 3 },
      });

      // No board access: Forbidden.
      expect((await work(seed.outsider.user_id, seed.kickoff.session_id)).status).toBe(403);
    } finally {
      await server.close();
    }
  }
);
