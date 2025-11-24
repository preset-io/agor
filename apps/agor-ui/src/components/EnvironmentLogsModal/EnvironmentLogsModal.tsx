import type { AgorClient } from '@agor/core/api';
import type { Worktree } from '@agor/core/types';
import { ReloadOutlined } from '@ant-design/icons';
import Ansi from 'ansi-to-react';
import { Alert, Button, Checkbox, Modal, Space, Typography, theme } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';

const { Text } = Typography;

interface EnvironmentLogsModalProps {
  open: boolean;
  onClose: () => void;
  worktree: Worktree;
  client: AgorClient | null;
}

interface LogsResponse {
  logs: string;
  timestamp: string;
  error?: string;
  truncated?: boolean;
}

export const EnvironmentLogsModal: React.FC<EnvironmentLogsModalProps> = ({
  open,
  onClose,
  worktree,
  client,
}) => {
  const { token } = theme.useToken();
  const [logs, setLogs] = useState<LogsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const logsContainerRef = useRef<HTMLDivElement>(null);
  const logsRef = useRef<LogsResponse | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLogs = useCallback(
    async (shouldAutoScroll = false, isManualRefresh = false) => {
      if (!client) return;

      // Check if user is scrolled to bottom before fetching
      const container = logsContainerRef.current;
      const isAtBottom =
        container &&
        Math.abs(container.scrollHeight - container.scrollTop - container.clientHeight) < 10;

      // Only show loading spinner for manual refreshes
      if (isManualRefresh) {
        setLoading(true);
      }

      try {
        // Call the custom logs endpoint using Feathers client with query params
        const data = (await client.service('worktrees/logs').find({
          query: {
            worktree_id: worktree.worktree_id,
          },
        })) as unknown as LogsResponse;
        setLogs(data);
        logsRef.current = data;

        // Auto-scroll to bottom if shouldAutoScroll is true AND (user was already at bottom OR first load)
        const hadLogs = !!logsRef.current;
        if (shouldAutoScroll && (isAtBottom || !hadLogs)) {
          setTimeout(() => {
            container?.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
          }, 100);
        }
      } catch (error: unknown) {
        const errorData = {
          logs: '',
          timestamp: new Date().toISOString(),
          error: error instanceof Error ? error.message : 'Failed to fetch logs',
        };
        setLogs(errorData);
        logsRef.current = errorData;
      } finally {
        if (isManualRefresh) {
          setLoading(false);
        }
      }
    },
    [client, worktree.worktree_id]
  );

  // Fetch logs when modal opens
  useEffect(() => {
    if (open) {
      fetchLogs(true, true); // Auto-scroll on initial load, show loading spinner
    } else {
      setLogs(null); // Clear logs when modal closes
      logsRef.current = null;
    }
  }, [open, fetchLogs]);

  // Auto-refresh interval
  useEffect(() => {
    // Clear any existing interval
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    // Set up new interval if auto-refresh is enabled and modal is open
    if (autoRefresh && open) {
      intervalRef.current = setInterval(() => {
        fetchLogs(true); // true = enable auto-scroll
      }, 3000); // 3 seconds
    }

    // Cleanup on unmount or when dependencies change
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [autoRefresh, open, fetchLogs]);

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleString();
  };

  return (
    <Modal
      title={`Environment Logs - ${worktree.name}`}
      open={open}
      onCancel={onClose}
      width={900}
      style={{ top: 20 }}
      footer={[
        <Checkbox
          key="auto-refresh"
          checked={autoRefresh}
          onChange={(e) => setAutoRefresh(e.target.checked)}
        >
          Auto-refresh
        </Checkbox>,
        <Button
          key="refresh"
          icon={<ReloadOutlined />}
          onClick={() => fetchLogs(false, true)}
          loading={loading}
        >
          Refresh
        </Button>,
        <Button key="close" onClick={onClose}>
          Close
        </Button>,
      ]}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {/* Timestamp and truncation warning */}
        {logs && !logs.error && (
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Fetched at: {formatTimestamp(logs.timestamp)}
            </Text>
            {logs.truncated && (
              <Alert
                message="Logs truncated (showing last 500 lines)"
                type="warning"
                showIcon
                style={{ marginTop: 8 }}
                banner
              />
            )}
          </div>
        )}

        {/* Error state */}
        {logs?.error && (
          <Alert
            message="Error fetching logs"
            description={
              <div>
                <div>{logs.error}</div>
                {logs.error.includes('No logs command') && (
                  <div style={{ marginTop: 8, fontSize: 12 }}>
                    Configure a 'logs' command in .env-config.yaml to view logs.
                  </div>
                )}
              </div>
            }
            type="error"
            showIcon
          />
        )}

        {/* Logs display */}
        {logs && !logs.error && (
          <div
            ref={logsContainerRef}
            style={{
              backgroundColor: '#000',
              border: `1px solid ${token.colorBorder}`,
              borderRadius: token.borderRadius,
              padding: 16,
              height: '60vh',
              overflowY: 'auto',
              fontFamily: 'monospace',
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: '#fff',
            }}
          >
            {logs.logs ? <Ansi>{logs.logs}</Ansi> : '(no logs)'}
          </div>
        )}

        {/* Loading state */}
        {loading && !logs && (
          <div
            style={{
              textAlign: 'center',
              padding: 40,
              color: token.colorTextSecondary,
              height: '60vh',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            Loading logs...
          </div>
        )}
      </Space>
    </Modal>
  );
};
