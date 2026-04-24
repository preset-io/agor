import {
  CheckCircleOutlined,
  LoadingOutlined,
  ReloadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Space, Tooltip } from 'antd';
import { useEffect, useState } from 'react';
import { useConnectionState } from '../../contexts/ConnectionContext';
import { Tag } from '../Tag';

export interface ConnectionStatusProps {
  connected: boolean;
  connecting: boolean;
  onRetry?: () => void;
}

/**
 * ConnectionStatus - Shows real-time WebSocket connection status
 *
 * States:
 * - Out of sync: Amber refresh icon (FE/BE drift after a deploy — supersedes
 *   Connected and Disconnected; click to hard-reload the tab)
 * - Connected: Green checkmark (only shown briefly after reconnect)
 * - Reconnecting: Yellow spinner (shown during reconnection)
 * - Disconnected: Red warning (shown when connection lost, click to retry)
 *
 * Auto-hides after 3 seconds when connected to reduce visual clutter.
 *
 * `outOfSync` is read from ConnectionContext (populated by useServerVersion in
 * App.tsx). It's deliberately checked first — when the daemon's build SHA has
 * changed under us, refreshing the tab matters more than any other connection
 * detail. We don't auto-reload (per design); the user clicks.
 */
export const ConnectionStatus: React.FC<ConnectionStatusProps> = ({
  connected,
  connecting,
  onRetry,
}) => {
  const { outOfSync, capturedSha, currentSha } = useConnectionState();
  const [showConnected, setShowConnected] = useState(false);
  const [justReconnected, setJustReconnected] = useState(false);

  // Track when we transition from connecting -> connected to show "Connected!" briefly
  useEffect(() => {
    if (connected && !connecting && justReconnected) {
      setShowConnected(true);
      const timer = setTimeout(() => {
        setShowConnected(false);
        setJustReconnected(false);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [connected, connecting, justReconnected]);

  // Track reconnection events
  useEffect(() => {
    if (connecting && !connected) {
      setJustReconnected(true);
    }
  }, [connecting, connected]);

  // Out of sync: backend was redeployed under us. Supersedes both connected
  // and disconnected — the user needs to refresh, period. No auto-reload, since
  // that would nuke a half-typed message or open modal. Tooltip surfaces the
  // actual SHA diff so the user can see *what* changed before reloading.
  if (outOfSync) {
    const tooltipTitle =
      capturedSha && currentSha
        ? `Daemon was upgraded from ${capturedSha} to ${currentSha} since this tab loaded. Click to reload and pick up the latest UI. Anything unsaved (form text, etc.) will be lost.`
        : 'Backend was updated — click to reload for the latest UI. Anything unsaved will be lost.';
    return (
      <Tooltip title={tooltipTitle} placement="bottom">
        <Tag
          icon={<ReloadOutlined />}
          color="warning"
          onClick={() => window.location.reload()}
          style={{
            margin: 0,
            display: 'flex',
            alignItems: 'center',
            cursor: 'pointer',
          }}
        >
          <Space size={4}>
            <span>Out of sync — refresh</span>
          </Space>
        </Tag>
      </Tooltip>
    );
  }

  // Don't show anything when normally connected (reduces clutter)
  if (connected && !connecting && !showConnected) {
    return null;
  }

  // Disconnected state
  if (!connected && !connecting) {
    return (
      <Tooltip title="Connection lost. Click to retry connection..." placement="bottom">
        <Tag
          icon={<WarningOutlined />}
          color="error"
          onClick={onRetry}
          style={{
            margin: 0,
            display: 'flex',
            alignItems: 'center',
            cursor: 'pointer',
          }}
        >
          <Space size={4}>
            <span>Disconnected</span>
          </Space>
        </Tag>
      </Tooltip>
    );
  }

  // Reconnecting state
  if (connecting || !connected) {
    return (
      <Tooltip title="Reconnecting to daemon..." placement="bottom">
        <Tag
          icon={<LoadingOutlined spin />}
          color="warning"
          style={{
            margin: 0,
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <Space size={4}>
            <span>Reconnecting</span>
          </Space>
        </Tag>
      </Tooltip>
    );
  }

  // Just reconnected - show success briefly
  if (showConnected) {
    return (
      <Tooltip title="Connected to daemon" placement="bottom">
        <Tag
          icon={<CheckCircleOutlined />}
          color="success"
          style={{
            margin: 0,
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <Space size={4}>
            <span>Connected</span>
          </Space>
        </Tag>
      </Tooltip>
    );
  }

  return null;
};
