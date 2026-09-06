import type { AgorClient, Board, User } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BoardSwitcher } from './BoardSwitcher';

const modalProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('../BoardEditModal', () => ({
  BoardEditModal: (props: Record<string, unknown>) => {
    modalProps.current = props;
    return props.open ? <div role="dialog">board editor</div> : null;
  },
}));

const adversarialBoardName = `Board-${'unbroken-name-'.repeat(30)}終`;
const board = {
  board_id: 'board-1',
  name: adversarialBoardName,
  created_by: 'owner-1',
  primary_owner_user_id: 'owner-1',
  created_at: '',
  last_updated: '',
} as Board;
const owner = { user_id: 'owner-1', role: 'member' } as User;

function clientFor({ reject, findResult }: { reject?: unknown; findResult?: unknown } = {}) {
  return {
    service: () => ({
      find: vi
        .fn()
        .mockImplementation(() =>
          reject ? Promise.reject(reject) : Promise.resolve(findResult ?? [])
        ),
      findAll: vi.fn().mockResolvedValue([]),
    }),
  } as unknown as AgorClient;
}

function renderSwitcher(client = clientFor(), user: User = owner) {
  const onBoardChange = vi.fn();
  const view = render(
    <BoardSwitcher
      boards={[board]}
      currentBoardId={board.board_id}
      onBoardChange={onBoardChange}
      branchById={new Map()}
      client={client}
      currentUser={user}
      onUpdateBoard={vi.fn()}
    />
  );
  return { ...view, onBoardChange };
}

describe('BoardSwitcher long-name layout', () => {
  it('constrains every generated wrapper while keeping the name flexible and badge fixed', async () => {
    const { container } = renderSwitcher();
    const trigger = container.querySelector<HTMLButtonElement>('button.ant-dropdown-trigger');
    expect(trigger).not.toBeNull();

    const currentName = trigger?.querySelector<HTMLElement>('[data-current-board-name]');
    expect(currentName?.parentElement).toHaveStyle({ flex: '1', minWidth: '0' });
    expect(currentName?.parentElement?.style.overflow).toBe('');
    expect(currentName).toHaveStyle({ flex: '1', minWidth: '0' });
    expect(trigger?.querySelector('.anticon-down')).toHaveStyle({ flexShrink: '0' });

    fireEvent.click(trigger as HTMLButtonElement);

    const item = await screen.findByRole('menuitem');
    const itemContent = item.querySelector<HTMLElement>('.ant-dropdown-menu-title-content');
    const name = item.querySelector<HTMLElement>('[data-board-name]');
    const badgeRoot = item.querySelector<HTMLElement>('.ant-badge');
    const badgeIndicator = item.querySelector<HTMLElement>('.ant-badge-count');
    const popup = screen.getByTestId('board-switcher-popup');

    // jsdom has no layout engine: assert the durable semantic/style contracts,
    // not pixel ellipsis behavior (which is covered in browser E2E).
    expect(itemContent).toHaveStyle({ minWidth: '0' });
    expect(name).toHaveClass('ant-typography-ellipsis');
    expect(name).toHaveStyle({ flex: '1', minWidth: '0' });
    expect(name).toHaveTextContent(adversarialBoardName);
    expect(badgeRoot).toHaveStyle({ flexShrink: '0' });
    expect(badgeRoot?.style.backgroundColor).toBe('');
    expect(badgeIndicator?.style.flexShrink).toBe('');
    expect(badgeIndicator?.style.backgroundColor).not.toBe('');
    expect(popup).toHaveStyle({ width: '320px', maxWidth: 'calc(100vw - 48px)' });
  });

  it('reveals a clipped name when its menu item receives keyboard focus', async () => {
    const { container } = renderSwitcher();
    const trigger = container.querySelector<HTMLButtonElement>('button.ant-dropdown-trigger');
    fireEvent.click(trigger as HTMLButtonElement);

    const item = await screen.findByRole('menuitem');
    const name = item.querySelector<HTMLElement>('[data-board-name]');
    const popup = screen.getByTestId('board-switcher-popup');
    const menu = screen.getByRole('menu');
    expect(name).not.toBeNull();
    Object.defineProperties(name as HTMLElement, {
      clientWidth: { configurable: true, value: 120 },
      scrollWidth: { configurable: true, value: 800 },
    });

    act(() => popup.focus());
    expect(popup).toHaveAttribute('tabindex', '-1');
    expect(menu).toHaveFocus();

    act(() => item.focus());

    expect(item).toHaveFocus();
    expect(name).not.toHaveAttribute('tabindex');
    expect(await screen.findByRole('tooltip')).toHaveTextContent(adversarialBoardName);
  });
});

describe('BoardSwitcher current-board edit shortcut', () => {
  it('allows the primary owner without consulting a legacy owners route', async () => {
    renderSwitcher(clientFor({ reject: { code: 500 } }));
    expect(await screen.findByRole('button', { name: /Edit current board:/ })).toBeVisible();
  });

  it('passes only the current board to the canonical editor and does not navigate', async () => {
    const { onBoardChange } = renderSwitcher();
    const edit = await screen.findByRole('button', { name: /Edit current board:/ });

    fireEvent.click(edit);

    expect(onBoardChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent('board editor');
    expect(modalProps.current?.board).toBe(board);
  });

  it('overlays the edit action without reserving trigger width', async () => {
    renderSwitcher();
    const edit = await screen.findByRole('button', { name: /Edit current board:/ });
    const trigger = edit.closest('div')?.querySelector('button.ant-dropdown-trigger');

    expect(trigger).toHaveStyle({ padding: '8px 12px' });
    expect(edit.closest('span[style*="position: absolute"]')).toHaveStyle({ right: '28px' });
  });

  it('reserves room in the name row so a long name never underlaps the edit action', async () => {
    renderSwitcher();
    const edit = await screen.findByRole('button', { name: /Edit current board:/ });
    const trigger = edit.closest('div')?.querySelector('button.ant-dropdown-trigger');
    // controlHeightSM (24) + paddingSM (12) with the default antd seed token.
    expect(trigger?.querySelector('.ant-flex')).toHaveStyle({ marginRight: '36px' });
  });

  it('keeps the action keyboard reachable and reveals it on focus-within', async () => {
    renderSwitcher();
    const edit = await screen.findByRole('button', { name: /Edit current board:/ });
    act(() => edit.focus());
    expect(edit).toHaveFocus();
    await waitFor(() =>
      expect(edit.closest('span[style*="opacity"]')).toHaveStyle({
        opacity: '1',
        pointerEvents: 'auto',
      })
    );
  });

  it('hides the action when normalized policy resolution denies management', async () => {
    renderSwitcher(clientFor({ findResult: { capabilities: ['board.view'] } }), {
      user_id: 'member-2',
      role: 'member',
    } as User);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Edit current board:/ })).not.toBeInTheDocument()
    );
  });

  it('keeps the action visible without hover on small/touch layouts', async () => {
    renderSwitcher();
    const edit = await screen.findByRole('button', { name: /Edit current board:/ });
    expect(edit).toBeVisible();
  });
});
