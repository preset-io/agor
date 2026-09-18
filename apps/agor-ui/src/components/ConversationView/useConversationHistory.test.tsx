import type { SessionID } from '@agor/core/types';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { largeSessionFixture } from '../../../../../test/fixtures/large-session';
import { useConversationHistory } from './useConversationHistory';

const scrollRef = { current: null };

describe('conversation render history', () => {
  it('honors canonical Session task order rather than assuming timestamps are monotonic', () => {
    const { sessionId, tasks } = largeSessionFixture(65, 0);
    const rows = [...tasks].reverse();
    const { result, rerender } = renderHook(
      ({ rows }) => useConversationHistory(sessionId, rows, false, scrollRef, vi.fn()),
      { initialProps: { rows } }
    );
    const revealed = rows.slice(-30);
    expect(result.current.visibleTasks).toEqual(revealed);
    // The Session append/reorder can arrive after the Task event. Previously
    // shown tasks remain present even when their canonical positions change.
    const reordered = [rows.at(-1)!, ...rows.slice(0, -1)];
    rerender({ rows: reordered });
    expect(result.current.visibleTasks).toEqual(reordered);
    expect(revealed.every((task) => result.current.visibleTasks.includes(task))).toBe(true);
  });

  it.each([0, 1, 29, 30, 31, 60, 61, 95])(
    'reveals %i tasks without gaps or duplicates',
    (count) => {
      const { sessionId, tasks } = largeSessionFixture(count, 0);
      const { result } = renderHook(() =>
        useConversationHistory(sessionId, tasks, false, scrollRef, vi.fn())
      );
      expect(result.current.visibleTasks).toEqual(tasks.slice(-30));
      while (result.current.olderCount) {
        const previous = result.current.visibleTasks;
        act(() => result.current.revealOlder());
        expect(result.current.visibleTasks.slice(-previous.length)).toEqual(previous);
      }
      expect(result.current.visibleTasks).toEqual(tasks);
      expect(new Set(result.current.visibleTasks.map((t) => t.task_id)).size).toBe(count);
    }
  );

  it('keeps a stable deterministic boundary through arrivals, removals and patches', () => {
    const fixture = largeSessionFixture(65, 0);
    const tasks = fixture.tasks.map((task) => ({
      ...task,
      created_at: '2026-01-01T00:00:00.000Z',
    }));
    const { result, rerender } = renderHook(
      ({ rows }) => useConversationHistory(fixture.sessionId, rows, false, scrollRef, vi.fn()),
      { initialProps: { rows: tasks.slice(0, 64) } }
    );
    const firstId = result.current.visibleTasks[0].task_id;
    // New tail must not evict the task currently being read.
    rerender({ rows: tasks });
    expect(result.current.visibleTasks[0].task_id).toBe(firstId);
    expect(result.current.visibleTasks).toHaveLength(31);
    const remaining = tasks
      .filter((t) => t.task_id !== firstId)
      .map((t) => ({ ...t, full_prompt: `${t.full_prompt} patched` }));
    rerender({ rows: remaining });
    expect(result.current.visibleTasks).toEqual(remaining.slice(34));
    act(() => result.current.revealOlder());
    act(() => result.current.revealOlder());
    expect(result.current.visibleTasks).toEqual(remaining);
  });

  it('accepts late backfilled tasks without moving the existing render boundary', () => {
    const { sessionId, tasks } = largeSessionFixture(65, 0);
    const { result, rerender } = renderHook(
      ({ rows }) => useConversationHistory(sessionId, rows, false, scrollRef, vi.fn()),
      { initialProps: { rows: tasks.slice(1) } }
    );
    const first = result.current.visibleTasks[0];
    rerender({ rows: tasks });
    expect(result.current.visibleTasks[0]).toBe(first);
    act(() => result.current.revealAllAtTop());
    expect(result.current.visibleTasks).toEqual(tasks);
  });

  it('resets on session change, initializes after loading, and preserves the search escape hatch', () => {
    const fixture = largeSessionFixture(65, 0);
    const stop = vi.fn();
    const { result, rerender } = renderHook(
      ({ sessionId, rows, all }) => useConversationHistory(sessionId, rows, all, scrollRef, stop),
      {
        initialProps: { sessionId: fixture.sessionId, rows: fixture.tasks.slice(0, 0), all: false },
      }
    );
    rerender({ sessionId: fixture.sessionId, rows: fixture.tasks, all: false });
    expect(result.current.visibleTasks).toHaveLength(30);
    act(() => result.current.revealOlder());
    expect(result.current.visibleTasks).toHaveLength(60);
    rerender({ sessionId: fixture.sessionId, rows: fixture.tasks, all: true });
    expect(result.current.visibleTasks).toEqual(fixture.tasks);
    expect(result.current.olderCount).toBe(0);
    rerender({ sessionId: fixture.sessionId, rows: fixture.tasks, all: false });
    expect(result.current.visibleTasks).toEqual(fixture.tasks);
    rerender({ sessionId: 'other-session' as SessionID, rows: fixture.tasks, all: false });
    expect(result.current.visibleTasks).toHaveLength(30);
    act(() => result.current.revealAllAtTop());
    expect(result.current.visibleTasks).toEqual(fixture.tasks);
    expect(stop).toHaveBeenCalledTimes(2);
  });
});
