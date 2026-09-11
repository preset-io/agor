import type { Session } from '@agor-live/client';
import { Flex, Pagination } from 'antd';
import { type ReactNode, useState } from 'react';
import { BRANCH_SESSION_VIEWPORT_HEIGHT } from './branchCardLayout';

const PAGE_SIZE = 20;

/** Bound flat rows as well as height; a scrollbar alone still mounts every row. */
export function PagedSessions({
  sessions,
  children,
}: {
  sessions: Session[];
  children: (session: Session) => ReactNode;
}) {
  const [requestedPage, setPage] = useState(1);
  // Archive/removal events can shrink the collection while a later page is open.
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(sessions.length / PAGE_SIZE)));
  // Keep the recovered page when the collection grows again; do not jump back
  // to a page that disappeared during the removal.
  if (page !== requestedPage) setPage(page);
  return (
    <Flex vertical gap={4} className="nodrag nowheel">
      <Flex
        vertical
        gap={4}
        style={{ maxHeight: BRANCH_SESSION_VIEWPORT_HEIGHT, overflowY: 'auto' }}
        key={page}
      >
        {sessions.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(children)}
      </Flex>
      {sessions.length > PAGE_SIZE && (
        <Pagination
          simple
          current={page}
          total={sessions.length}
          pageSize={PAGE_SIZE}
          showSizeChanger={false}
          onChange={setPage}
          size="small"
        />
      )}
    </Flex>
  );
}
