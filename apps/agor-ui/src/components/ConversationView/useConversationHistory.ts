import type { SessionID, Task } from '@agor/core/types';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

export const CONVERSATION_TASK_PAGE_SIZE = 30;

/** A render boundary, not a data cursor: the reactive session still owns all tasks. */
interface Boundary {
  sessionId: SessionID | null;
  taskIds: ReadonlySet<string>;
}

function boundaryFor(sessionId: SessionID | null, tasks: Task[]): Boundary {
  return { sessionId, taskIds: new Set(tasks.map((task) => task.task_id)) };
}

export function useConversationHistory(
  sessionId: SessionID | null,
  tasks: Task[],
  showAll: boolean,
  scrollRef: { current: HTMLElement | null },
  stopScroll: () => void
) {
  const [boundary, setBoundary] = useState<Boundary | null>(() => {
    return tasks.length ? boundaryFor(sessionId, tasks.slice(-CONVERSATION_TASK_PAGE_SIZE)) : null;
  });
  const anchor = useRef<{ element: HTMLElement; top: number } | null>(null);
  const jumpToTop = useRef(false);
  const startIndex = useMemo(() => {
    if (!boundary || boundary.sessionId !== sessionId) {
      return Math.max(0, tasks.length - CONVERSATION_TASK_PAGE_SIZE);
    }
    // Preserve the client's canonical Session.tasks order (which can differ
    // from timestamps). Keep every already-revealed task mounted through
    // arrivals, deletions and Session ordering patches, rather than shifting
    // a fixed-size suffix and evicting what the user is reading.
    const index = tasks.findIndex((task) => boundary.taskIds.has(task.task_id));
    return index === -1 ? Math.max(0, tasks.length - CONVERSATION_TASK_PAGE_SIZE) : index;
  }, [boundary, sessionId, tasks]);

  const visibleTasks = useMemo(
    () => (showAll ? tasks : tasks.slice(startIndex)),
    [showAll, startIndex, tasks]
  );

  useLayoutEffect(() => {
    // Search intentionally materializes everything. Keep those task shells
    // after search closes so their normal collapse effects unload messages;
    // unmounting them here would leave search-hydrated messages cached.
    if (
      visibleTasks.length &&
      (boundary?.sessionId !== sessionId ||
        boundary.taskIds.size !== visibleTasks.length ||
        visibleTasks.some((task) => !boundary.taskIds.has(task.task_id)))
    ) {
      setBoundary(boundaryFor(sessionId, visibleTasks));
    } else if (!visibleTasks.length && boundary) {
      setBoundary(null);
    }
    // Restore geometry before paint. Measuring the same DOM element also
    // handles native scroll anchoring (a browser that already compensated
    // produces a zero delta), instead of double-applying scrollHeight changes.
    const pending = anchor.current;
    anchor.current = null;
    const scroller = scrollRef.current;
    if (scroller && pending && scroller.contains(pending.element)) {
      scroller.scrollTop += pending.element.getBoundingClientRect().top - pending.top;
    }
    if (scroller && jumpToTop.current) scroller.scrollTop = 0;
    jumpToTop.current = false;
  });

  const revealOlder = useCallback(() => {
    const next = tasks.slice(Math.max(0, startIndex - CONVERSATION_TASK_PAGE_SIZE));
    if (!next.length) return;
    stopScroll();
    const element = scrollRef.current?.querySelector<HTMLElement>('[data-task-block]');
    anchor.current = element ? { element, top: element.getBoundingClientRect().top } : null;
    setBoundary(boundaryFor(sessionId, next));
  }, [scrollRef, sessionId, startIndex, stopScroll, tasks]);

  const revealAllAtTop = useCallback(() => {
    stopScroll();
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    if (!tasks[0]) return;
    jumpToTop.current = true;
    setBoundary(boundaryFor(sessionId, tasks));
  }, [scrollRef, sessionId, stopScroll, tasks]);

  return {
    visibleTasks,
    olderCount: showAll ? 0 : startIndex,
    revealOlder,
    revealAllAtTop,
  };
}
