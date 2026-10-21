import type { AgorClient, BoardFileItem, BoardView, UserID } from '@agor-live/client';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardViewContext, type BoardViewContextValue } from '../../contexts/BoardViewContext';
import type { BoardPreviewTarget } from '../../hooks/useBoardPreview';
import { BoardPreviewPane } from './BoardPreviewPane';

vi.mock('../MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
  UploadAttachmentLink: ({ children }: { children: React.ReactNode }) => (
    <button type="button" aria-label={`Download ${children}`}>
      {children}
    </button>
  ),
}));
// Sandpack does not load under jsdom; the sandbox itself is the full screen page's.
vi.mock('./ArtifactPreview', () => ({
  ArtifactPreview: ({ artifactId }: { artifactId: string }) => <div>Sandbox {artifactId}</div>,
}));

const item = (overrides: Partial<BoardFileItem>): BoardFileItem => ({
  kind: 'document',
  id: 'doc-1',
  name: 'Talking points',
  made_at: '2026-10-21T10:00:00.000Z',
  created_at: '2026-10-21T10:00:00.000Z',
  made_by: { user_id: 'user-1' as UserID },
  source: { session_id: 'session-1', title: 'QBR prep' } as BoardFileItem['source'],
  status: 'Shared',
  ...overrides,
});

const docClient = (get: () => Promise<unknown>) =>
  ({ service: vi.fn(() => ({ get: vi.fn(get) })) }) as unknown as AgorClient;

function renderPane(
  target: BoardPreviewTarget,
  {
    client = null,
    view = 'files',
    currentSessionId = null,
  }: { client?: AgorClient | null; view?: BoardView; currentSessionId?: string | null } = {}
) {
  const handlers = { onShowOnBoard: vi.fn(), onClose: vi.fn(), onToggleFullScreen: vi.fn() };
  const context: BoardViewContextValue = {
    view,
    showOnBoard: vi.fn(),
    previewTarget: target,
    openPreview: vi.fn(),
    closePreview: vi.fn(),
    openConversation: vi.fn(),
  };
  render(
    <AntApp>
      <BoardViewContext.Provider value={context}>
        <BoardPreviewPane
          client={client}
          user={null}
          target={target}
          currentSessionId={currentSessionId}
          fullScreen={false}
          {...handlers}
        />
      </BoardViewContext.Provider>
    </AntApp>
  );
  return { ...handlers, onOpenConversation: context.openConversation };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('document preview', () => {
  const target = { kind: 'document', id: 'doc-1', item: item({}) } as BoardPreviewTarget;

  it('reads the document under the reader’s access and opens its conversation', async () => {
    const handlers = renderPane(target, {
      client: docClient(async () => ({ content: '# Talking points\n\nWins first.' })),
    });
    expect(screen.getByRole('region', { name: 'Preview: Talking points' })).toBeInTheDocument();
    expect(screen.getByText('Document · Shared')).toBeInTheDocument();
    expect(await screen.findByText(/Wins first\./)).toBeInTheDocument();
    // Documents are not cards on the board.
    expect(screen.queryByRole('button', { name: /Show on board/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Open conversation/ }));
    expect(handlers.onOpenConversation).toHaveBeenCalledWith('session-1');
  });

  it('says it is no longer available when the read fails', async () => {
    renderPane(target, { client: docClient(async () => Promise.reject(new Error('403'))) });
    expect(await screen.findByText('No longer available')).toBeInTheDocument();
  });

  it('leaves out Open conversation for the conversation already shown in Chat', () => {
    renderPane(target, {
      client: docClient(async () => ({ content: '' })),
      view: 'chat',
      currentSessionId: 'session-1',
    });
    expect(screen.queryByRole('button', { name: /Open conversation/ })).toBeNull();
  });
});

describe('artifact preview', () => {
  it('renders the sandbox and shows the artifact on the board', async () => {
    const handlers = renderPane({
      kind: 'artifact',
      id: 'artifact-1',
      item: item({ kind: 'artifact', id: 'artifact-1', name: 'Dashboard', status: 'Live' }),
    } as BoardPreviewTarget);
    expect(await screen.findByText('Sandbox artifact-1')).toBeInTheDocument();
    expect(screen.getByText('Artifact · Live')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Show on board/ }));
    expect(handlers.onShowOnBoard).toHaveBeenCalledWith('artifact-1', 'artifact');
  });
});

describe('upload preview', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:logo', revokeObjectURL: () => {} })
    );
  });

  it('shows a raster image inline, read with the reader’s credentials', async () => {
    const fetchMock = vi.fn(async () => new Response(new Blob(['png'], { type: 'image/png' })));
    vi.stubGlobal('fetch', fetchMock);
    renderPane({
      kind: 'upload',
      ref: 'upl_1',
      item: item({
        kind: 'upload',
        id: 'upl_1',
        name: 'logo.png',
        mime_type: 'image/png',
        size_bytes: 2048,
      }),
    } as BoardPreviewTarget);
    expect(screen.getByText('Upload · PNG, 2 KB')).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'logo.png' })).toHaveAttribute(
      'src',
      'blob:logo'
    );
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/uploads/upl_1/content');
    expect(screen.queryByRole('button', { name: /Show on board/ })).toBeNull();
  });

  it('shows any other file’s name, type and size with the download control (A7)', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderPane({
      kind: 'upload',
      ref: 'upl_2',
      item: item({
        kind: 'upload',
        id: 'upl_2',
        name: 'usage.csv',
        mime_type: 'text/csv',
        size_bytes: 45,
      }),
    } as BoardPreviewTarget);
    expect(screen.getByText('CSV · 45 B')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download usage.csv' })).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
