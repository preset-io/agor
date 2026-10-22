import type { BoardView } from '@agor-live/client';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useBoardView } from './useBoardView';
import { userStorageKey } from './useUserLocalStorage';

const CHAT_FIRST: BoardView[] = ['chat', 'board'];
const BOARD_FIRST: BoardView[] = ['board', 'chat'];

const render = (initial: { boardId: string | null; order: BoardView[] }) =>
  renderHook((props) => useBoardView({ userId: 'u1', ...props }), { initialProps: initial });

afterEach(() => localStorage.clear());

describe('useBoardView', () => {
  it('opens a first visit on the first tab', () => {
    expect(render({ boardId: 'b1', order: CHAT_FIRST }).result.current.view).toBe('chat');
    expect(render({ boardId: 'b2', order: BOARD_FIRST }).result.current.view).toBe('board');
  });

  it('remembers a picked tab per user per board, even after the order changes', () => {
    const first = render({ boardId: 'b1', order: CHAT_FIRST });
    act(() => first.result.current.pick('board'));
    expect(first.result.current.view).toBe('board');
    expect(JSON.parse(localStorage.getItem(userStorageKey('u1', 'board-view:b1'))!)).toBe('board');

    const returning = render({ boardId: 'b1', order: CHAT_FIRST });
    expect(returning.result.current.view).toBe('board');
    expect(render({ boardId: 'b2', order: CHAT_FIRST }).result.current.view).toBe('chat');
  });

  it('keeps the tab someone landed on when an editor moves another tab first', () => {
    const { result, rerender } = render({ boardId: 'b1', order: BOARD_FIRST });
    expect(result.current.view).toBe('board');
    rerender({ boardId: 'b1', order: CHAT_FIRST });
    expect(result.current.view).toBe('board');
  });

  it('falls back to the first tab when the picked one is not shown', () => {
    localStorage.setItem(userStorageKey('u1', 'board-view:b1'), JSON.stringify('files'));
    expect(render({ boardId: 'b1', order: BOARD_FIRST }).result.current.view).toBe('board');
  });

  it('shows a visit without remembering it', () => {
    const { result } = render({ boardId: 'b1', order: CHAT_FIRST });
    act(() => result.current.visit('board'));
    expect(result.current.view).toBe('board');
    expect(localStorage.getItem(userStorageKey('u1', 'board-view:b1'))).toBeNull();
    act(() => result.current.pick('chat'));
    expect(result.current.view).toBe('chat');
  });

  it('clears a visit when the board changes, and keeps one made for the board being opened', () => {
    const { result, rerender } = render({ boardId: 'b1', order: CHAT_FIRST });
    act(() => result.current.visit('board'));
    rerender({ boardId: 'b2', order: CHAT_FIRST });
    expect(result.current.view).toBe('chat');
    rerender({ boardId: 'b1', order: CHAT_FIRST });
    expect(result.current.view).toBe('chat');

    act(() => result.current.visit('board', 'b3'));
    expect(result.current.view).toBe('chat');
    rerender({ boardId: 'b3', order: CHAT_FIRST });
    expect(result.current.view).toBe('board');
  });

  it('never shows the previous board’s pick after a board switch', () => {
    localStorage.setItem(userStorageKey('u1', 'board-view:b1'), JSON.stringify('board'));
    const { result, rerender } = render({ boardId: 'b1', order: CHAT_FIRST });
    expect(result.current.view).toBe('board');
    rerender({ boardId: 'b2', order: CHAT_FIRST });
    expect(result.current.view).toBe('chat');
  });
});
