import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  boardViewPreferenceKey,
  parseBoardViewPreferences,
  useBoardViewPreferences,
} from './useBoardViewPreferences';

beforeEach(() => {
  localStorage.clear();
});
describe('board view preferences', () => {
  it('defaults to tree without writing anything', () => {
    const { result } = renderHook(() => useBoardViewPreferences('a', 'one'));
    expect(result.current[0]).toMatchObject({
      view: 'tree',
      tab: 'sessions',
      sort: 'alpha',
      expanded: {},
    });
    expect(localStorage.length).toBe(0);
  });
  it('isolates users and tenant-owned boards, restores only that partition', () => {
    const { result, rerender } = renderHook(
      ({ user, board }) => useBoardViewPreferences(user, board),
      { initialProps: { user: 'a', board: 'one' } }
    );
    act(() => result.current[1]({ view: 'board', expanded: { branch: true }, sort: 'recent' }));
    rerender({ user: 'b', board: 'one' });
    expect(result.current[0]).toMatchObject({ view: 'tree', expanded: {}, sort: 'alpha' });
    act(() => result.current[1]({ tab: 'content' }));
    rerender({ user: 'a', board: 'two' });
    expect(result.current[0]).toMatchObject({ view: 'tree', tab: 'sessions', expanded: {} });
    rerender({ user: 'a', board: 'one' });
    expect(result.current[0]).toMatchObject({
      view: 'board',
      sort: 'recent',
      expanded: { branch: true },
      tab: 'sessions',
    });
    expect(boardViewPreferenceKey('/workspace-a', 'a', 'one')).not.toBe(
      boardViewPreferenceKey('/workspace-b', 'a', 'one')
    );
  });
  it('does not persist anonymous or boardless navigation', () => {
    const { result } = renderHook(() => useBoardViewPreferences(undefined, 'one'));
    act(() => result.current[1]({ view: 'board' }));
    expect(localStorage.length).toBe(0);
  });
  it('validates storage and keeps navigation usable when storage is unavailable', () => {
    expect(
      parseBoardViewPreferences({
        view: 'invalid',
        tab: 'old',
        sort: 'bad',
        scrollTop: -20,
        expanded: { a: true, b: 'true' },
      })
    ).toMatchObject({
      view: 'tree',
      tab: 'sessions',
      sort: 'alpha',
      scrollTop: 0,
      expanded: { a: true },
    });
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage unavailable');
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderHook(() => useBoardViewPreferences('restricted', 'one'));
    act(() => result.current[1]({ view: 'board' }));
    expect(result.current[0].view).toBe('board');
    spy.mockRestore();
    log.mockRestore();
  });
  it('merges updates from multiple mounted surfaces without losing fields', () => {
    const a = renderHook(() => useBoardViewPreferences('a', 'one'));
    const b = renderHook(() => useBoardViewPreferences('a', 'one'));
    act(() => a.result.current[1]({ view: 'board' }));
    act(() => b.result.current[1]({ tab: 'content' }));
    expect(a.result.current[0]).toMatchObject({ view: 'board', tab: 'content' });
  });
});
