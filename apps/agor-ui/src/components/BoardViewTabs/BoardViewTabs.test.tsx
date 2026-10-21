import type { BoardView } from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardViewTabs } from './BoardViewTabs';

const ORDER: BoardView[] = ['board', 'chat', 'files'];

afterEach(cleanup);

const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(name) });

const openMenu = async (name: string) => {
  fireEvent.contextMenu(within(tab(name)).getByText(name));
  return await screen.findByRole('menu');
};

describe('BoardViewTabs', () => {
  it('shows only the available tabs, labelled, in the board order', () => {
    render(<BoardViewTabs order={['chat', 'files', 'board']} view="chat" onPick={vi.fn()} />);
    expect(screen.getAllByRole('tab').map((node) => node.textContent)).toEqual(['Chat', 'Board']);
  });

  it('remembers a click as a pick', () => {
    const onPick = vi.fn();
    render(<BoardViewTabs order={ORDER} view="board" onPick={onPick} />);
    fireEvent.click(tab('Chat'));
    expect(onPick).toHaveBeenCalledWith('chat');
  });

  it('gives viewers no grip, tooltip or menu', async () => {
    render(<BoardViewTabs order={ORDER} view="board" onPick={vi.fn()} />);
    fireEvent.contextMenu(within(tab('Chat')).getByText('Chat'));
    fireEvent.mouseEnter(within(tab('Chat')).getByText('Chat'));
    await act(() => new Promise((resolve) => setTimeout(resolve, 600)));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByText('Drag to reorder. Alt + arrow keys also move it.')).toBeNull();
    expect(document.querySelector('.anticon-holder')).toBeNull();
  });

  it('disables Move left on the first tab and Move right on the last', async () => {
    const onReorder = vi.fn();
    render(<BoardViewTabs order={ORDER} view="board" onPick={vi.fn()} onReorder={onReorder} />);
    const first = await openMenu('Board');
    expect(
      within(first).getByRole('menuitem', { name: 'Move left' }).getAttribute('aria-disabled')
    ).toBe('true');
    fireEvent.click(within(first).getByRole('menuitem', { name: 'Move right' }));
    expect(onReorder).toHaveBeenCalledWith(['chat', 'board', 'files']);
  });

  it('moves the focused tab with Alt + arrow keys and stops the browser default', () => {
    const onReorder = vi.fn();
    render(<BoardViewTabs order={ORDER} view="board" onPick={vi.fn()} onReorder={onReorder} />);
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    tab('Chat').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onReorder).toHaveBeenCalledWith(['chat', 'board', 'files']);
  });

  it('says where the board now opens when the first tab changes', () => {
    const onReorder = vi.fn();
    render(<BoardViewTabs order={ORDER} view="board" onPick={vi.fn()} onReorder={onReorder} />);
    fireEvent.keyDown(tab('Chat'), { key: 'ArrowLeft', altKey: true });
    expect(screen.getByText('This board now opens on Chat for everyone.')).toBeTruthy();
  });
});
