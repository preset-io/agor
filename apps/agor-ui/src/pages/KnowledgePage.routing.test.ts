import { describe, expect, it } from 'vitest';
import {
  buildKnowledgeDocumentRouteUrl,
  buildKnowledgeQueryString,
  resolveActiveKnowledgeDocument,
  shouldDeferKnowledgeUrlMirrorForRoute,
} from './KnowledgePage';

type TestDoc = { document_id: string; path: string; title: string };

const pageDoc: TestDoc = {
  document_id: 'doc-page',
  path: 'pages/readme.md',
  title: 'Readme',
};

const skillDoc: TestDoc = {
  document_id: 'doc-skill',
  path: 'skills/triage.md',
  title: 'Triage Skill',
};

describe('KnowledgePage routing state helpers', () => {
  it('keeps the active document from the snapshot when the sidebar filter hides it', () => {
    expect(
      resolveActiveKnowledgeDocument({
        activeDocId: pageDoc.document_id,
        draftDocument: null,
        documents: [skillDoc],
        activeDocSnapshot: pageDoc,
      })
    ).toBe(pageDoc);
  });

  it('prefers the current filtered document over a stale snapshot', () => {
    const refreshedPage = { ...pageDoc, title: 'Updated Readme' };

    expect(
      resolveActiveKnowledgeDocument({
        activeDocId: pageDoc.document_id,
        draftDocument: null,
        documents: [refreshedPage],
        activeDocSnapshot: pageDoc,
      })
    ).toBe(refreshedPage);
  });

  it('preserves draft page state when rebuilding query params during edit mode', () => {
    expect(
      buildKnowledgeQueryString({
        query: ' onboarding ',
        kind: 'Skills',
        editing: true,
        activeDocId: '__knowledge_draft__',
      })
    ).toBe('?q=onboarding&kind=skills&draft=page&mode=edit');
  });

  it('omits draft state for normal document edit routes', () => {
    expect(
      buildKnowledgeQueryString({
        kind: 'Pages',
        editing: true,
        activeDocId: pageDoc.document_id,
      })
    ).toBe('?kind=pages&mode=edit');
  });

  it('preserves the current query string when mirroring the open document route', () => {
    expect(
      buildKnowledgeDocumentRouteUrl({
        routeBasePath: '/knowledge',
        namespaceSlug: 'global',
        documentPath: 'untitled.md',
        currentSearch: '?kind=pages',
      })
    ).toBe('/knowledge/global/untitled.md?kind=pages');
  });

  it('defers URL mirroring while the route points at a different document', () => {
    expect(
      shouldDeferKnowledgeUrlMirrorForRoute({
        routeDocumentPath: skillDoc.path,
        activeDocPath: pageDoc.path,
      })
    ).toBe(true);

    expect(
      shouldDeferKnowledgeUrlMirrorForRoute({
        routeDocumentPath: pageDoc.path,
        activeDocPath: pageDoc.path,
      })
    ).toBe(false);
  });
});
