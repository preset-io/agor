// biome-ignore-all lint/plugin/noHardcodedColorProperty: log output intentionally uses a fixed terminal-like surface
import type { AgorClient, Branch } from '@agor-live/client';
import { ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Checkbox, Modal, Space, Tabs, Typography, theme } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthConfig } from '../../hooks/useAuthConfig';
import {
  getEnvironmentCommandStatus,
  hasEnvironmentCommandLogs,
} from '../../utils/environmentCommand';
import { Ansi } from '../AnsiText';
import { ErrorBoundary } from '../ErrorBoundary';
import { EnvironmentCommandLogs } from './EnvironmentCommandLogs';

const { Text } = Typography;

const LOGS_AUTO_REFRESH_INTERVAL_MS = 10_000;

interface EnvironmentLogsModalProps {
  open: boolean;
  onClose: () => void;
  branch: Branch;
  client: AgorClient | null;
}

interface LogsResponse {
  logs: string;
  timestamp: string;
  error?: string;
  truncated?: boolean;
}

// Keep retained output and in-flight requests scoped to the displayed branch.
export const EnvironmentLogsModal: React.FC<EnvironmentLogsModalProps> = (props) => (
  <EnvironmentLogsContent key={props.branch.branch_id} {...props} />
);

const EnvironmentLogsContent: React.FC<EnvironmentLogsModalProps> = ({
  open,
  onClose,
  branch,
  client,
}) => {
  const { token } = theme.useToken();
  const { featuresConfig } = useAuthConfig();
  const shellLogsUnavailable =
    featuresConfig?.environmentCommands?.shellLogs === false &&
    !!branch.logs_command &&
    !/^https?:\/\//i.test(branch.logs_command.trim());
  const runtimeUnavailableReason = !branch.logs_command
    ? 'No runtime logs command configured.'
    : shellLogsUnavailable
      ? (featuresConfig?.environmentCommands?.shellLogsReason ?? 'Runtime shell logs unavailable.')
      : undefined;
  const commandStatus = getEnvironmentCommandStatus(branch.environment_instance);
  const preferCommands =
    hasEnvironmentCommandLogs(branch.environment_instance) &&
    (runtimeUnavailableReason ||
      commandStatus?.type !== 'info' ||
      branch.environment_instance?.status === 'error' ||
      (branch.environment_instance?.command_attempt &&
        !branch.environment_instance.command_attempt.finished_at));
  const [selectedTab, setSelectedTab] = useState<string>();
  const activeTab = selectedTab ?? (preferCommands ? 'commands' : 'runtime');
  const showRuntime = activeTab === 'runtime';
  const [logs, setLogs] = useState<LogsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const logsContainerRef = useRef<HTMLDivElement>(null);
  const logsRef = useRef<LogsResponse | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fetchInFlightRef = useRef(false);
  const requestGenerationRef = useRef(0);

  const fetchLogs = useCallback(
    async (shouldAutoScroll = false, isManualRefresh = false) => {
      if (!client || runtimeUnavailableReason || fetchInFlightRef.current) return;
      fetchInFlightRef.current = true;
      const generation = requestGenerationRef.current;

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
        const data = (await client.service('branches/logs').find({
          query: {
            branch_id: branch.branch_id,
          },
        })) as unknown as LogsResponse;
        if (generation !== requestGenerationRef.current) return;
        const hadLogs = !!logsRef.current;
        setLogs(data);
        logsRef.current = data;

        // Auto-scroll to bottom if shouldAutoScroll is true AND (user was already at bottom OR first load)
        if (shouldAutoScroll && (isAtBottom || !hadLogs)) {
          setTimeout(() => {
            if (generation === requestGenerationRef.current) {
              const current = logsContainerRef.current;
              current?.scrollTo({ top: current.scrollHeight, behavior: 'smooth' });
            }
          }, 100);
        }
      } catch (error: unknown) {
        if (generation !== requestGenerationRef.current) return;
        const errorData = {
          logs: '',
          timestamp: new Date().toISOString(),
          error: error instanceof Error ? error.message : 'Failed to fetch logs',
        };
        setLogs(errorData);
        logsRef.current = errorData;
      } finally {
        if (generation === requestGenerationRef.current) {
          fetchInFlightRef.current = false;
          if (isManualRefresh) setLoading(false);
        }
      }
    },
    [client, branch.branch_id, runtimeUnavailableReason]
  );

  // Fetch logs when modal opens
  useEffect(() => {
    if (open && showRuntime) {
      fetchLogs(true, true); // Auto-scroll on initial load, show loading spinner
    } else if (!open) {
      setLogs(null); // Clear logs when modal closes
      logsRef.current = null;
      setSelectedTab(undefined);
    }
    return () => {
      requestGenerationRef.current++;
      fetchInFlightRef.current = false;
    };
  }, [open, showRuntime, fetchLogs]);

  // Auto-refresh interval
  useEffect(() => {
    // Clear any existing interval
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    // Set up new interval if auto-refresh is enabled and modal is open
    if (autoRefresh && open && showRuntime && !runtimeUnavailableReason) {
      intervalRef.current = setInterval(() => {
        fetchLogs(true); // true = enable auto-scroll
      }, LOGS_AUTO_REFRESH_INTERVAL_MS);
    }

    // Cleanup on unmount or when dependencies change
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [autoRefresh, open, showRuntime, runtimeUnavailableReason, fetchLogs]);

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleString();
  };

  const runtimeContent = runtimeUnavailableReason ? (
    <Text type="secondary">{runtimeUnavailableReason}</Text>
  ) : (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      {/* Timestamp and truncation warning */}
      {logs && !logs.error && (
        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Fetched at: {formatTimestamp(logs.timestamp)}
          </Text>
          {logs.truncated && (
            <Alert
              title="Logs truncated (showing last 500 lines)"
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
        <Alert title={`Runtime logs unavailable: ${logs.error}`} type="error" showIcon />
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
          {logs.logs ? <Ansi>{String(logs.logs)}</Ansi> : '(no logs)'}
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
  );

  return (
    <Modal
      title={`Environment Logs - ${branch.name}`}
      open={open}
      onCancel={onClose}
      width={900}
      style={{ top: 20 }}
      footer={[
        showRuntime && !runtimeUnavailableReason && (
          <Checkbox
            key="auto-refresh"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          >
            Auto-refresh
          </Checkbox>
        ),
        showRuntime && !runtimeUnavailableReason && (
          <Button
            key="refresh"
            icon={<ReloadOutlined />}
            onClick={() => fetchLogs(false, true)}
            loading={loading}
          >
            Refresh
          </Button>
        ),
        <Button key="close" onClick={onClose}>
          Close
        </Button>,
      ]}
    >
      <ErrorBoundary fallbackTitle="Couldn't render the logs viewer." resetKey={logs?.timestamp}>
        <Tabs
          activeKey={activeTab}
          onChange={setSelectedTab}
          items={[
            {
              key: 'commands',
              label: 'Commands',
              children: <EnvironmentCommandLogs environment={branch.environment_instance} />,
            },
            { key: 'runtime', label: 'Runtime', children: runtimeContent },
          ]}
        />
      </ErrorBoundary>
    </Modal>
  );
};
