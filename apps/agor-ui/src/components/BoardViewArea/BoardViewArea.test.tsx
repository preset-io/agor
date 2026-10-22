import type { BranchID, User } from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { useBoardViewContext } from '../../contexts/BoardViewContext';
import type { BoardViewShell } from '../../hooks/useBoardViewShell';
import { BoardViewArea } from './BoardViewArea';

const width = vi.hoisted(() => ({ px: 1200 }));
vi.mock('../../hooks/useElementWidth', () => ({ useElementWidth: () => width.px }));

vi.mock('../BoardPreview', async () => {
  const { forwardRef } = await import('react');
  const { useBoardViewContext } = await import('../../contexts/BoardViewContext');
  return {
    BoardPreviewPane: forwardRef<
      HTMLElement,
      { fullScreen: boolean; onToggleFullScreen?: () => void; onClose: () => void }
    >(function Pane({ fullScreen, onToggleFullScreen, onClose }, ref) {
      const boardView = useBoardViewContext();
      return (
        <section ref={ref} tabIndex={-1} aria-label="Preview: northwind-qbr">
          {onToggleFullScreen && (
            <button type="button" onClick={onToggleFullScreen}>
              {fullScreen ? 'Exit' : 'Open'}
            </button>
          )}
          <button type="button" onClick={() => boardView?.openConversation('session-2')}>
            QBR prep
          </button>
          <button type="button" onClick={onClose}>
            Close preview
          </button>
        </section>
      );
    }),
  };
});

// jsdom has no layout, so the panels record their imperative calls, and the
// groups and handles keep their callbacks for a test to drive a drag.
const panels = vi.hoisted(() => ({
  calls: [] as string[],
  onLayout: new Map<string, (sizes: number[]) => void>(),
  onDragging: [] as ((dragging: boolean) => void)[],
}));
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
    PanelGroup: ({
      id,
      onLayout,
      children,
    }: {
      id: string;
      onLayout?: (sizes: number[]) => void;
      children?: React.ReactNode;
    }) => {
      if (onLayout) panels.onLayout.set(id, onLayout);
      return <div>{children}</div>;
    },
    PanelResizeHandle: ({ onDragging }: { onDragging?: (dragging: boolean) => void }) => {
      if (onDragging) panels.onDragging.push(onDragging);
      return <div />;
    },
  };
});

const target = { kind: 'branch', id: 'branch-1' as BranchID } as const;

const counts = vi.hoisted(() => ({ mounts: 0, renders: 0 }));
// Stands in for the session panel: reads the context, opens the preview.
function Conversation() {
  const boardView = useBoardViewContext();
  counts.renders += 1;
  useEffect(() => {
    counts.mounts += 1;
  }, []);
  return (
    <div>
      <textarea aria-label="Message" />
      <button type="button" onClick={() => boardView?.openPreview({ ...target })}>
        Branch details
      </button>
      <button
        type="button"
        onClick={() =>
          boardView?.openPreview(
            { ...target },
            { returnFocus: document.getElementById('card') as HTMLElement }
          )
        }
      >
        Details from the card
      </button>
    </div>
  );
}

function shell(overrides: Partial<BoardViewShell> = {}): BoardViewShell {
  const isChat = overrides.isChat ?? true;
  return {
    ready: true,
    view: 'chat',
    isChat,
    isFiles: false,
    chatLayout: isChat,
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
    boardId: 'board-1',
    ...overrides,
  } as BoardViewShell;
}

const onSessionClick = vi.fn();
const renderArea = (s: BoardViewShell = shell()) => (
  <AppActionsProvider value={{ onSessionClick }}>
    <BoardViewArea
      shell={s}
      client={null}
      user={{ user_id: 'user-1' } as User}
      canvas={
        <button type="button" id="card">
          Card
        </button>
      }
      conversation={<Conversation />}
      sessionPanel={{ size: 50, minSize: 20, maxSize: 80 }}
    />
  </AppActionsProvider>
);

const mainArea = () =>
  document.querySelector('[data-panel-id="board-view-main"]')?.firstElementChild as HTMLElement;
const region = () => screen.getByRole('region', { name: 'Preview: northwind-qbr' });
const queryRegion = () => screen.queryByRole('region', { name: /Preview/ });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));

/** Opens Branch details from the conversation, focusing the trigger first as a click would. */
function openFromConversation(name = 'Branch details') {
  const trigger = screen.getByRole('button', { name });
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
}

afterEach(() => {
  cleanup();
  counts.mounts = 0;
  counts.renders = 0;
  panels.calls = [];
  panels.onLayout.clear();
  panels.onDragging = [];
  width.px = 1200;
  onSessionClick.mockReset();
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('BoardViewArea preview', () => {
  it('shows the preview beside Chat and moves focus into it', () => {
    render(renderArea());
    expect(queryRegion()).toBeNull();
    openFromConversation();
    expect(document.activeElement).toBe(region());
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
    expect(mainArea()).not.toHaveAttribute('inert');
  });

  it('collapses the main area for full screen without unmounting it', () => {
    render(renderArea());
    openFromConversation();
    panels.calls = [];
    click('Open');
    expect(panels.calls).toEqual(['collapse board-view-main']);
    expect(screen.getByRole('button', { name: 'Exit' })).toBeInTheDocument();
    expect(mainArea()).toHaveAttribute('inert');
    expect(mainArea()).toHaveAttribute('aria-hidden', 'true');
    panels.calls = [];
    click('Exit');
    // Exit expands the main area and restores the kept split.
    expect(panels.calls).toEqual(['expand board-view-main', 'resize board-view-preview']);
    expect(mainArea()).not.toHaveAttribute('inert');
    expect(counts.mounts).toBe(1);
  });

  it('opens full screen with no Exit when the window is narrower than both minimums', () => {
    width.px = 823;
    render(renderArea());
    openFromConversation();
    expect(region()).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(Open|Exit)$/ })).toBeNull();
    expect(mainArea()).toHaveAttribute('inert');
    expect(panels.calls).toContain('collapse board-view-main');
  });

  it('keeps the split when both minimums and the divider fit', () => {
    width.px = 824;
    render(renderArea());
    openFromConversation();
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
    expect(mainArea()).not.toHaveAttribute('inert');
  });

  it('hides the preview on Board and shows it again in Chat, without remounting the conversation', () => {
    const { rerender } = render(renderArea());
    openFromConversation();
    rerender(renderArea(shell({ view: 'board', isChat: false })));
    expect(queryRegion()).toBeNull();
    screen.getByRole('textbox', { name: 'Message' }).focus();
    rerender(renderArea());
    // Coming back is not a new open: focus stays where it was.
    expect(document.activeElement).not.toBe(region());
    expect(counts.mounts).toBe(1);
  });

  it('re-renders neither the conversation nor context readers while the divider is dragged', () => {
    render(renderArea());
    openFromConversation();
    const renders = counts.renders;
    const previewHandle = panels.onDragging.at(-1);
    act(() => previewHandle?.(true));
    act(() => panels.onLayout.get('board-view')?.([40, 60]));
    act(() => panels.onLayout.get('board-view')?.([35, 65]));
    act(() => previewHandle?.(false));
    expect(counts.renders).toBe(renders);
    expect(localStorage.getItem('agor:user:user-1:panel:preview:size')).toBe('65');
  });
});

describe('BoardViewArea opening a conversation from the preview', () => {
  it('leaves full screen so the conversation is seen', () => {
    render(renderArea());
    openFromConversation();
    click('Open');
    expect(mainArea()).toHaveAttribute('inert');
    click('QBR prep');
    expect(onSessionClick).toHaveBeenCalledWith('session-2');
    expect(region()).toBeInTheDocument();
    expect(mainArea()).not.toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
  });

  it('keeps the split as it is', () => {
    render(renderArea());
    openFromConversation();
    click('QBR prep');
    expect(onSessionClick).toHaveBeenCalledWith('session-2');
    expect(region()).toBeInTheDocument();
    expect(mainArea()).not.toHaveAttribute('inert');
  });

  it('closes the preview when the window is too narrow for both', () => {
    width.px = 823;
    render(renderArea());
    openFromConversation();
    click('QBR prep');
    expect(onSessionClick).toHaveBeenCalledWith('session-2');
    expect(queryRegion()).toBeNull();
    expect(mainArea()).not.toHaveAttribute('inert');
  });
});

describe('BoardViewArea preview focus', () => {
  const activeBoardTab = () => screen.getByRole('tab', { selected: true });

  it('returns focus to the trigger on close, also from full screen', () => {
    render(renderArea());
    const trigger = openFromConversation();
    click('Open');
    region().focus();
    click('Close preview');
    expect(queryRegion()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('moves focus again when another item is opened in its place', () => {
    render(renderArea());
    openFromConversation();
    screen.getByRole('textbox', { name: 'Message' }).focus();
    openFromConversation();
    expect(document.activeElement).toBe(region());
  });

  it('falls back to the active board tab when the trigger is gone', () => {
    render(renderArea());
    const trigger = openFromConversation();
    trigger.remove();
    click('Close preview');
    expect(document.activeElement).toBe(activeBoardTab());
  });

  it('falls back to the active board tab when the trigger is inert', () => {
    render(renderArea());
    // The canvas is inert in Chat.
    openFromConversation('Details from the card');
    click('Close preview');
    expect(document.activeElement).toBe(activeBoardTab());
  });

  it('leaves focus alone on close when it is already somewhere else', () => {
    render(renderArea());
    openFromConversation();
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(document.activeElement).toBe(elsewhere);
  });

  it('moves focus from the composer into the preview when the window turns too narrow', () => {
    const { rerender } = render(renderArea());
    openFromConversation();
    const composer = screen.getByRole('textbox', { name: 'Message' });
    composer.focus();
    width.px = 823;
    rerender(renderArea());
    expect(mainArea()).toHaveAttribute('inert');
    expect(document.activeElement).toBe(region());
  });

  it('never takes focus from an open modal when the window turns too narrow', () => {
    const { rerender } = render(renderArea());
    openFromConversation();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const field = document.createElement('input');
    dialog.append(field);
    document.body.append(dialog);
    field.focus();
    width.px = 823;
    rerender(renderArea());
    expect(document.activeElement).toBe(field);
  });
});
