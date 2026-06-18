import { describe, expect, it } from 'vitest';
import { filterSelectOptionBySearchText } from '../utils/selectSearch';
import {
  areKnowledgeSearchResultsFresh,
  buildKnowledgeDocumentRouteUrl,
  buildKnowledgeNamespaceSelectOptions,
  buildKnowledgeQueryString,
  buildKnowledgeSearchResultKey,
  isKnowledgeDocumentContentReady,
  matchesKnowledgeSidebarFilter,
  resolveActiveKnowledgeDocument,
  resolveKnowledgeSpaceAfterNamespacesLoad,
  shouldDeferKnowledgeUrlMirrorForRoute,
  shouldShowKnowledgeGraphView,
  shouldShowKnowledgeRouteDocumentLoading,
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
        editing: true,
        activeDocId: '__knowledge_draft__',
      })
    ).toBe('?q=onboarding&draft=page&mode=edit');
  });

  it('omits draft state for normal document edit routes', () => {
    expect(
      buildKnowledgeQueryString({
        editing: true,
        activeDocId: pageDoc.document_id,
      })
    ).toBe('?mode=edit');
  });

  it('preserves route-owned query params and drops local-only filters when mirroring', () => {
    expect(
      buildKnowledgeDocumentRouteUrl({
        routeBasePath: '/knowledge',
        namespaceSlug: 'global',
        documentPath: 'untitled.md',
        currentSearch: '?kind=pages&mode=edit&q=onboarding',
      })
    ).toBe('/knowledge/global/untitled.md?mode=edit&q=onboarding');
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

  it('uses a loading state, not the graph, while a direct document route resolves', () => {
    expect(
      shouldShowKnowledgeRouteDocumentLoading({
        activeDocMatchesRoute: false,
        routeDocumentResolutionFailed: false,
        routeNamespaceSlug: 'global',
        routeDocumentPath: pageDoc.path,
      })
    ).toBe(true);

    expect(
      shouldShowKnowledgeGraphView({
        activeDocPresent: false,
        isEditing: false,
        routeDocumentPath: pageDoc.path,
      })
    ).toBe(false);
  });

  it('stops showing the direct-route loading state after resolution fails', () => {
    expect(
      shouldShowKnowledgeRouteDocumentLoading({
        activeDocMatchesRoute: false,
        routeDocumentResolutionFailed: true,
        routeNamespaceSlug: 'global',
        routeDocumentPath: pageDoc.path,
      })
    ).toBe(false);
  });

  it('keeps graph home behavior for base and namespace Knowledge routes', () => {
    expect(
      shouldShowKnowledgeRouteDocumentLoading({
        activeDocMatchesRoute: false,
        routeDocumentResolutionFailed: false,
        routeNamespaceSlug: null,
        routeDocumentPath: '',
      })
    ).toBe(false);

    expect(
      shouldShowKnowledgeRouteDocumentLoading({
        activeDocMatchesRoute: false,
        routeDocumentResolutionFailed: false,
        routeNamespaceSlug: 'global',
        routeDocumentPath: '',
      })
    ).toBe(false);

    expect(
      shouldShowKnowledgeGraphView({
        activeDocPresent: false,
        isEditing: false,
        routeDocumentPath: '',
      })
    ).toBe(true);
  });

  it('waits for the routed document content before rendering the article', () => {
    expect(
      isKnowledgeDocumentContentReady({
        activeDocId: pageDoc.document_id,
        activeDocDocumentId: pageDoc.document_id,
        isDraftDocument: false,
        versionsDocumentId: null,
      })
    ).toBe(false);

    expect(
      isKnowledgeDocumentContentReady({
        activeDocId: pageDoc.document_id,
        activeDocDocumentId: pageDoc.document_id,
        isDraftDocument: false,
        versionsDocumentId: pageDoc.document_id,
      })
    ).toBe(true);

    expect(
      isKnowledgeDocumentContentReady({
        activeDocId: '__knowledge_draft__',
        activeDocDocumentId: '__knowledge_draft__',
        isDraftDocument: true,
        versionsDocumentId: null,
      })
    ).toBe(true);
  });
});

describe('KnowledgePage sidebar quick-filter helpers', () => {
  it('matches title and path labels without requiring full-content search state', () => {
    expect(
      matchesKnowledgeSidebarFilter(['Onboarding Guide', 'pages/team/onboarding.md'], 'team')
    ).toBe(true);
    expect(
      matchesKnowledgeSidebarFilter(
        ['Onboarding Guide', 'pages/team/onboarding.md'],
        'onboard guide'
      )
    ).toBe(true);
    expect(
      matchesKnowledgeSidebarFilter(['Onboarding Guide', 'pages/team/onboarding.md'], 'billing')
    ).toBe(false);
  });

  it('treats an empty quick-filter as visible', () => {
    expect(matchesKnowledgeSidebarFilter(['Any page'], '   ')).toBe(true);
  });
});

describe('KnowledgePage global search helpers', () => {
  it('marks results stale when the query or mode changes', () => {
    const resultKey = buildKnowledgeSearchResultKey('readme', 'text');

    expect(areKnowledgeSearchResultsFresh({ resultKey, query: ' readme ', mode: 'text' })).toBe(
      true
    );
    expect(areKnowledgeSearchResultsFresh({ resultKey, query: 'billing', mode: 'text' })).toBe(
      false
    );
    expect(areKnowledgeSearchResultsFresh({ resultKey, query: 'readme', mode: 'hybrid' })).toBe(
      false
    );
    expect(areKnowledgeSearchResultsFresh({ resultKey, query: '', mode: 'text' })).toBe(false);
  });
});

describe('KnowledgePage namespace select helpers', () => {
  it('keeps All Spaces selected after namespaces refresh', () => {
    expect(
      resolveKnowledgeSpaceAfterNamespacesLoad('all', [
        {
          namespace_id: 'ns-global',
          slug: 'global',
          display_name: 'Global',
        },
      ])
    ).toBe('all');
  });

  it('sorts namespace options by display name with slug fallback and searchable text', () => {
    expect(
      buildKnowledgeNamespaceSelectOptions([
        {
          namespace_id: 'ns-z',
          slug: 'zebra',
          display_name: 'Zebra Space',
        },
        {
          namespace_id: 'ns-a',
          slug: 'alpha-slug',
          display_name: 'Alpha Space',
        },
        {
          namespace_id: 'ns-b',
          slug: 'beta',
          display_name: null,
        },
        {
          namespace_id: 'ns-a2',
          slug: 'alpha-slug-2',
          display_name: 'Alpha Space',
        },
      ])
    ).toEqual([
      {
        label: 'Alpha Space',
        value: 'alpha-slug',
        searchText: 'alpha space alpha-slug',
      },
      {
        label: 'Alpha Space',
        value: 'alpha-slug-2',
        searchText: 'alpha space alpha-slug-2',
      },
      {
        label: 'beta',
        value: 'beta',
        searchText: 'beta beta',
      },
      {
        label: 'Zebra Space',
        value: 'zebra',
        searchText: 'zebra space zebra',
      },
    ]);
  });

  it('makes namespace options filterable by display name and slug', () => {
    const [option] = buildKnowledgeNamespaceSelectOptions([
      {
        namespace_id: 'ns-product',
        slug: 'product-docs',
        display_name: 'Product Knowledge',
      },
    ]);

    expect(filterSelectOptionBySearchText('product knowledge', option)).toBe(true);
    expect(filterSelectOptionBySearchText('product-docs', option)).toBe(true);
    expect(filterSelectOptionBySearchText('engineering', option)).toBe(false);
  });
});
