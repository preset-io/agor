import type { AgorClient, User } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App, ConfigProvider, theme } from 'antd';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgePage } from './KnowledgePage';

vi.mock('react-resizable-panels', () => ({
  Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PanelResizeHandle: () => null,
}));

vi.mock('../components/KnowledgeGraph', () => ({ KnowledgeGraph: () => <div>Graph</div> }));
vi.mock('../components/GlobalUserMenu', () => ({ GlobalUserMenu: () => null }));
vi.mock('../components/EmojiPickerInput', () => ({ AgorEmojiPicker: () => null }));
vi.mock('../components/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

const namespaceId = '01900000-0000-7000-8000-000000000001';
const documentId = '01900000-0000-7000-8000-000000000002';
const userId = '01900000-0000-7000-8000-000000000003';
const versionId = '01900000-0000-7000-8000-000000000004';

function setup(owner = true) {
  let archived = true;
  const document = () => ({
    document_id: documentId,
    namespace_id: namespaceId,
    path: 'page.md',
    title: 'Archived fixture',
    uri: 'agor://kb/team/page.md',
    archived,
    visibility: 'public',
    edit_policy: 'owner',
    status: 'published',
    kind: 'doc',
    created_by: userId,
    current_version_id: versionId,
  });
  const namespace = {
    namespace_id: namespaceId,
    slug: 'team',
    display_name: 'Team',
    kind: 'team',
    archived: false,
    effective_permission: owner ? 'own' : 'read',
  };
  const findAll = vi.fn(async ({ query }: { query?: Record<string, unknown> } = {}) =>
    (query?.archive_filter ?? 'active') === 'all' ||
    (query?.archive_filter ?? 'active') === (archived ? 'archived' : 'active')
      ? [document()]
      : []
  );
  const patch = vi.fn(async (_id: string, data: { archived: boolean }) => {
    archived = data.archived;
    return document();
  });
  const find = vi.fn(async () => ({ total: 1, data: [document()] }));
  const documentService = { findAll, find, patch, on: vi.fn(), off: vi.fn() };
  const client = {
    service: (path: string) => {
      if (path === 'kb/documents') return documentService;
      if (path === 'kb/namespaces') return { find: async () => [namespace] };
      if (path === 'kb/versions')
        return {
          find: async () => [
            {
              version_id: versionId,
              document_id: documentId,
              version_number: 1,
              content_text: '# Preserved body',
              created_at: '2026-01-01',
            },
          ],
        };
      if (path === 'kb/graph') return { find: async () => ({ nodes: [], edges: [] }) };
      return { find: async () => [] };
    },
  } as unknown as AgorClient;
  const user = { user_id: owner ? userId : 'other', role: 'member', name: 'Fixture' } as User;
  render(
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
      <App>
        <MemoryRouter initialEntries={['/kb/team/page.md']}>
          <Routes>
            <Route
              path="/kb/:namespaceSlug/*"
              element={<KnowledgePage client={client} currentUser={user} />}
            />
          </Routes>
        </MemoryRouter>
      </App>
    </ConfigProvider>
  );
  return { patch, find, findAll, documentService, document };
}

describe('Knowledge archived direct links', () => {
  // jsdom's cssstyle cannot resolve AntD 6 CSS-variable border shorthands.
  // These are interaction tests, not browser layout/style assertions.
  beforeEach(() => {
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      (element) => (element as HTMLElement).style
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('keeps the body/history accessible outside the active tree and restores without a modal or reload', async () => {
    const { patch, findAll } = setup();
    expect((await screen.findByText('Archived page')).isConnected).toBe(true);
    expect((await screen.findByText('# Preserved body')).isConnected).toBe(true);
    expect((screen.getByRole('button', { name: /Edit$/ }) as HTMLButtonElement).disabled).toBe(
      true
    );
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(documentId, {
        archived: false,
        expected_archived: true,
        expected_version: versionId,
      })
    );
    await waitFor(() => expect(screen.queryByText('Archived page')).toBeNull());
    expect((await screen.findByText('Page restored')).isConnected).toBe(true);
    expect(findAll).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ archive_filter: 'active' }) })
    );
  });

  it('names the action when a restore is rejected', async () => {
    const { patch } = setup();
    patch.mockRejectedValueOnce(
      new Error('Knowledge document archive state changed; reload before retrying')
    );
    await screen.findByText('Archived page');
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(
      (
        await screen.findByText(
          "Couldn't restore the page. It changed since you opened it, so refresh and try again."
        )
      ).isConnected
    ).toBe(true);
    expect(screen.getByText('Archived page').isConnected).toBe(true);
  });

  it('offers archived-only discovery and restoration in the same simple browser', async () => {
    const { findAll } = setup();
    await screen.findByText('Archived page');
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Knowledge archive filter' }));
    fireEvent.click(await screen.findByText('Archived pages'));
    await waitFor(() =>
      expect(findAll).toHaveBeenCalledWith(
        expect.objectContaining({ query: expect.objectContaining({ archive_filter: 'archived' }) })
      )
    );
    expect((screen.getByRole('button', { name: 'Restore' }) as HTMLButtonElement).disabled).toBe(
      false
    );
  });

  it('updates an open archived page on an authorized realtime restore event', async () => {
    const { documentService, document } = setup();
    await screen.findByText('Archived page');
    const callback = documentService.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'patched'
    )?.[1] as unknown as (data: ReturnType<typeof document>) => void;
    expect(callback).toBeTypeOf('function');
    await act(async () => {
      const restored = await documentService.patch(documentId, { archived: false });
      callback(restored);
    });
    await waitFor(() => expect(screen.queryByText('Archived page')).toBeNull());
  });

  it('shows archive state without offering restoration to a reader', async () => {
    setup(false);
    expect((await screen.findByText('Archived page')).isConnected).toBe(true);
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
  });
});
