import type { Session } from '@agor-live/client';
import { Flex, Pagination } from 'antd';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { BRANCH_SESSION_VIEWPORT_HEIGHT } from './branchCardLayout';

const PAGE_SIZE = 20;

/** Bound flat rows as well as height; a scrollbar alone still mounts every row. */
export function PagedSessions({
  sessions,
  children,
  rowGap = 4,
  fillAvailableHeight = false,
  onContentSizeChange,
}: {
  sessions: Session[];
  children: (session: Session) => ReactNode;
  /** Space between rows; flush lists (the teammate panel) pass 0. */
  rowGap?: number;
  /** Fill a bounded flex slot (the teammate panel) instead of the card's fixed viewport. */
  fillAvailableHeight?: boolean;
  onContentSizeChange?: (contentHeight: number, viewportHeight: number) => void;
}) {
  const [requestedPage, setPage] = useState(1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<(() => void) | null>(null);
  // Archive/removal events can shrink the collection while a later page is open.
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(sessions.length / PAGE_SIZE)));
  // Keep the recovered page when the collection grows again; do not jump back
  // to a page that disappeared during the removal.
  if (page !== requestedPage) setPage(page);

  // Same contract as BranchSessionTree: report rows vs. slot so the section caps at its content.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!fillAvailableHeight || !root) return;
    // Read refs at call time (the list remounts per page) and measure rows, not scrollHeight, which floors at the slot.
    const measure = () => {
      const list = listRef.current;
      const rows = rowsRef.current;
      if (list && rows && list.clientHeight > 0) {
        onContentSizeChange?.(rows.offsetHeight, list.clientHeight);
      }
    };
    measure();
    measureRef.current = measure;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => {
      measureRef.current = null;
      observer.disconnect();
    };
  }, [fillAvailableHeight, onContentSizeChange]);

  // Page turns and added/removed runs change content without resizing the slot.
  useLayoutEffect(() => {
    measureRef.current?.();
  });

  return (
    <Flex
      ref={rootRef}
      vertical
      gap={4}
      className="nodrag nowheel"
      style={fillAvailableHeight ? { flex: 1, minHeight: 0 } : undefined}
    >
      <div
        ref={listRef}
        style={
          fillAvailableHeight
            ? { flex: 1, minHeight: 0, overflowY: 'auto' }
            : { maxHeight: BRANCH_SESSION_VIEWPORT_HEIGHT, overflowY: 'auto' }
        }
        key={page}
      >
        <Flex ref={rowsRef} vertical gap={rowGap}>
          {sessions.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(children)}
        </Flex>
      </div>
      {sessions.length > PAGE_SIZE && (
        <Pagination
          simple
          current={page}
          total={sessions.length}
          pageSize={PAGE_SIZE}
          showSizeChanger={false}
          onChange={setPage}
          size="small"
          style={fillAvailableHeight ? { flexShrink: 0 } : undefined}
        />
      )}
    </Flex>
  );
}
