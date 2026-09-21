import type { Task, User } from '@agor-live/client';
import { Button, Flex, Popover, Tag } from 'antd';
import type { ReactNode } from 'react';

/** Small display-only disclosure. No extra requests and no raw SDK payload. */
export function LeanTurnMetadata({
  task,
  userById,
  children,
}: {
  task: Task;
  userById: Map<string, User>;
  children: ReactNode;
}) {
  const normalized = task.normalized_sdk_response;
  const author = task.created_by ? userById.get(task.created_by) : undefined;
  return (
    <Popover
      trigger={['hover', 'focus', 'click']}
      placement="bottomLeft"
      content={
        <Flex wrap gap="small" aria-label="Turn metadata">
          {task.model && <Tag>{task.model}</Tag>}
          {task.duration_ms !== undefined && <Tag>{(task.duration_ms / 1000).toFixed(1)}s</Tag>}
          {normalized && <Tag>{normalized.tokenUsage.totalTokens.toLocaleString()} tokens</Tag>}
          {author && <Tag>{author.name || author.email}</Tag>}
          <Tag>{new Date(task.created_at).toLocaleString()}</Tag>
        </Flex>
      }
    >
      <div style={{ minWidth: 0 }}>
        {children}
        <Button type="text" size="small" aria-label="Show turn metadata">
          Turn details
        </Button>
      </div>
    </Popover>
  );
}
