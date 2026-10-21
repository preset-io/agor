import type { BranchID } from '@agor-live/client';
import { cleanup, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardPreviewState } from '../../hooks/useBoardPreview';
import type { BoardViewShell } from '../../hooks/useBoardViewShell';
import { BoardViewArea } from './BoardViewArea';

const width = vi.hoisted(() => ({ px: 1200 }));
vi.mock('../../hooks/useElementWidth', () => ({ useElementWidth: () => width.px }));

vi.mock('../BoardPreview', async () => {
  const { forwardRef } = await import('react');
  return {
    BoardPreviewPane: forwardRef<
      HTMLElement,
      { fullScreen: boolean; onToggleFullScreen?: () => void; onClose: () => void }
    >(function Pane({ fullScreen, onToggleFullScreen }, ref) {
      return (
        <section ref={ref} tabIndex={-1} aria-label="Preview: northwind-qbr">
          {onToggleFullScreen && <button type="button">{fullScreen ? 'Exit' : 'Open'}</button>}
        </section>
      );
    }),
  };
});

// jsdom has no layout, so the panels record their imperative calls instead.
const panels = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('react-resizable-panels', async () => {
  const React = await import('react');
  const Panel = React.forwardRef<unknown, { id: string; children?: React.ReactNode }>(
    ({ id, children }, ref) => {
      React.useImperativeHandle(
        ref,
        () => ({
          collapse: () => panels.calls.push(`collapse ${id}`),
          expand: () => panels.calls.push(`expand ${id}`),
          resize: () => panels.calls.push(`resize ${id}`),
        }),
        [id]
      );
      return <div data-panel-id={id}>{children}</div>;
    }
  );
  return {
    Panel,
    PanelGroup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    PanelResizeHandle: () => <div />,
  };
});

const mounts = vi.hoisted(() => ({ count: 0 }));
function Conversation() {
  useEffect(() => {
    mounts.count += 1;
  }, []);
  return <textarea aria-label="Message" />;
}

const preview: BoardPreviewState = {
  target: { kind: 'branch', id: 'branch-1' as BranchID },
  fullScreen: false,
  openId: 1,
};

function shell(overrides: Partial<BoardViewShell> = {}): BoardViewShell {
  return {
    ready: true,
    view: 'chat',
    isChat: true,
    order: ['chat', 'board'],
    pick: vi.fn(),
    visit: vi.fn(),
    reorder: undefined,
    canManage: false,
    canvasMounted: false,
    highlightTip: null,
    highlightBranchId: null,
    clearHighlight: vi.fn(),
    showOnBoard: vi.fn(),
    preview,
    closePreview: vi.fn(),
    setPreviewFullScreen: vi.fn(),
    previewSize: 45,
    setPreviewSize: vi.fn(),
    context: null,
    ...overrides,
  } as BoardViewShell;
}

const renderArea = (s: BoardViewShell) => (
  <BoardViewArea
    shell={s}
    canvas={<div>Canvas</div>}
    conversation={<Conversation />}
    sessionPanel={{ size: 50, minSize: 20, maxSize: 80 }}
  />
);

const mainArea = () =>
  document.querySelector('[data-panel-id="board-view-main"]')?.firstElementChild as HTMLElement;

afterEach(() => {
  cleanup();
  mounts.count = 0;
  panels.calls = [];
  width.px = 1200;
});

describe('BoardViewArea preview', () => {
  it('shows the preview beside Chat and moves focus into it', () => {
    render(renderArea(shell()));
    const region = screen.getByRole('region', { name: 'Preview: northwind-qbr' });
    expect(document.activeElement).toBe(region);
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
    expect(mainArea()).not.toHaveAttribute('inert');
  });

  it('collapses the main area for full screen without unmounting it', () => {
    const { rerender } = render(renderArea(shell()));
    panels.calls = [];
    rerender(renderArea(shell({ preview: { ...preview, fullScreen: true } })));
    expect(panels.calls).toEqual(['collapse board-view-main']);
    expect(screen.getByRole('button', { name: 'Exit' })).toBeInTheDocument();
    expect(mainArea()).toHaveAttribute('inert');
    expect(mainArea()).toHaveAttribute('aria-hidden', 'true');
    panels.calls = [];
    rerender(renderArea(shell()));
    // Exit expands the main area and restores the kept split.
    expect(panels.calls).toEqual(['expand board-view-main', 'resize board-view-preview']);
    expect(mainArea()).not.toHaveAttribute('inert');
    expect(mounts.count).toBe(1);
  });

  it('opens full screen with no Exit when the window is narrower than both minimums', () => {
    width.px = 823;
    render(renderArea(shell()));
    expect(screen.getByRole('region', { name: 'Preview: northwind-qbr' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open|Exit/ })).toBeNull();
    expect(mainArea()).toHaveAttribute('inert');
    expect(panels.calls).toContain('collapse board-view-main');
  });

  it('keeps the split when both minimums and the divider fit', () => {
    width.px = 824;
    render(renderArea(shell()));
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
    expect(mainArea()).not.toHaveAttribute('inert');
  });

  it('hides the preview on Board and shows it again in Chat, without remounting the conversation', () => {
    const { rerender } = render(renderArea(shell()));
    rerender(renderArea(shell({ view: 'board', isChat: false })));
    expect(screen.queryByRole('region', { name: /Preview/ })).toBeNull();
    rerender(renderArea(shell()));
    const region = screen.getByRole('region', { name: 'Preview: northwind-qbr' });
    // Coming back is not a new open: focus stays where it was.
    expect(document.activeElement).not.toBe(region);
    expect(mounts.count).toBe(1);
  });
});
