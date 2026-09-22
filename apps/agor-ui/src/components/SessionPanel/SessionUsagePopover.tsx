import type { AgorClient } from '@agor-live/client';
import { DollarOutlined } from '@ant-design/icons';
import { Alert, Button, Descriptions, Popover, Space, Spin, Typography } from 'antd';
import { useState } from 'react';
import { useSessionUsage } from '../../hooks/useSessionUsage';

export function SessionUsagePopover({
  client,
  sessionId,
  userId,
}: {
  client: AgorClient | null;
  sessionId: string;
  userId?: string;
}) {
  const [open, setOpen] = useState(false);
  const { usage, error, loading, retry } = useSessionUsage(client, sessionId, open, userId);
  return (
    <Popover
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      title="Session usage"
      content={
        !client ? (
          <Alert type="info" title="Connect to load session usage." />
        ) : loading ? (
          <Spin aria-label="Loading usage" />
        ) : error ? (
          <Space direction="vertical">
            <Alert type="error" title={error} />
            <Button size="small" onClick={retry}>
              Retry
            </Button>
          </Space>
        ) : usage ? (
          <Space direction="vertical">
            <Descriptions
              size="small"
              column={1}
              items={[
                { key: 'cost', label: 'Estimated cost', children: `$${usage.cost.toFixed(4)}` },
                { key: 'total', label: 'Total tokens', children: usage.total.toLocaleString() },
                { key: 'input', label: 'Input', children: usage.input.toLocaleString() },
                { key: 'output', label: 'Output', children: usage.output.toLocaleString() },
                { key: 'read', label: 'Cache read', children: usage.cacheRead.toLocaleString() },
                {
                  key: 'creation',
                  label: 'Cache creation',
                  children: usage.cacheCreation.toLocaleString(),
                },
              ]}
            />
            <Typography.Text type="secondary">
              Snapshot at opening. Reopen to refresh.
            </Typography.Text>
          </Space>
        ) : null
      }
    >
      <Button
        size="small"
        type="text"
        icon={<DollarOutlined />}
        aria-label="Show session usage"
        aria-expanded={open}
      >
        Usage
      </Button>
    </Popover>
  );
}
