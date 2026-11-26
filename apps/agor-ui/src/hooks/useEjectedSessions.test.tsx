import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useEjectedSessions } from './useEjectedSessions';

describe('useEjectedSessions', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('ejects a session at a position and persists it per user and board', () => {
    const { result } = renderHook(() => useEjectedSessions('user-1', 'board-1'));

    act(() => result.current.ejectSession('session-a', { x: 10, y: 20 }));

    expect(result.current.ejectedSessions).toEqual({ 'session-a': { x: 10, y: 20 } });
    expect(
      JSON.parse(window.localStorage.getItem('agor:ejected:user-1:board-1') ?? 'null')
    ).toEqual({ 'session-a': { x: 10, y: 20 } });
  });

  it('only moves sessions that are already ejected', () => {
    const { result } = renderHook(() => useEjectedSessions('user-1', 'board-1'));

    act(() => result.current.updateEjectedPosition('missing', { x: 1, y: 1 }));
    expect(result.current.ejectedSessions).toEqual({});

    act(() => result.current.ejectSession('session-a', { x: 0, y: 0 }));
    act(() => result.current.updateEjectedPosition('session-a', { x: 5, y: 6 }));
    expect(result.current.ejectedSessions).toEqual({ 'session-a': { x: 5, y: 6 } });
  });

  it('removes a session on re-dock and on close', () => {
    const { result } = renderHook(() => useEjectedSessions('user-1', 'board-1'));
    act(() => {
      result.current.ejectSession('session-a', { x: 0, y: 0 });
      result.current.ejectSession('session-b', { x: 1, y: 1 });
    });

    act(() => result.current.redockSession('session-a'));
    expect(Object.keys(result.current.ejectedSessions)).toEqual(['session-b']);

    act(() => result.current.closeEjectedSession('session-b'));
    expect(result.current.ejectedSessions).toEqual({});
  });

  it('keeps each board its own ejected set', () => {
    const board1 = renderHook(() => useEjectedSessions('user-1', 'board-1'));
    const board2 = renderHook(() => useEjectedSessions('user-1', 'board-2'));

    act(() => board1.result.current.ejectSession('session-a', { x: 0, y: 0 }));

    expect(board1.result.current.ejectedSessions).toHaveProperty('session-a');
    expect(board2.result.current.ejectedSessions).toEqual({});
  });
});
