import type { AgorClient } from '@agor/core/api';
import type { Worktree } from '@agor/core/types';
import { ReloadOutlined } from '@ant-design/icons';
import Ansi from 'ansi-to-react';
import { Alert, Button, Modal, Space, Typography, theme } from 'antd';
import { useCallback, useEffect, useState } from 'react';

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

  const fetchLogs = useCallback(async () => {
    if (!client) return;

    setLoading(true);
    try {
      // Call the custom logs endpoint using Feathers client with query params
      const data = (await client.service('worktrees/logs').find({
        query: {
          worktree_id: worktree.worktree_id,
        },
      })) as unknown as LogsResponse;
      setLogs(data);
    } catch (error: unknown) {
      setLogs({
        logs: '',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Failed to fetch logs',
      });
    } finally {
      setLoading(false);
    }
  }, [client, worktree.worktree_id]);

  // Fetch logs when modal opens
  useEffect(() => {
    if (open) {
      fetchLogs();
    } else {
      setLogs(null); // Clear logs when modal closes
    }
  }, [open, fetchLogs]);

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleString();
  };

  return (
    <Modal
      title={`Environment Logs - ${worktree.name}`}
      open={open}
      onCancel={onClose}
      width={800}
      footer={[
        <Button key="refresh" icon={<ReloadOutlined />} onClick={fetchLogs} loading={loading}>
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
                message="Logs truncated (showing last 100 lines)"
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
            style={{
              backgroundColor: '#000',
              border: `1px solid ${token.colorBorder}`,
              borderRadius: token.borderRadius,
              padding: 16,
              maxHeight: '60vh',
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
            }}
          >
            Loading logs...
          </div>
        )}
      </Space>
    </Modal>
  );
};
