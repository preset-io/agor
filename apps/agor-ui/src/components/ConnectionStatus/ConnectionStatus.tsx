import { CheckCircleOutlined, LoadingOutlined, WarningOutlined } from '@ant-design/icons';
import { Space, Tooltip } from 'antd';
import { useEffect, useState } from 'react';
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
 * - Connected: Green checkmark (only shown briefly after reconnect)
 * - Reconnecting: Yellow spinner (shown during reconnection)
 * - Disconnected: Red warning (shown when connection lost, click to retry)
 *
 * Auto-hides after 3 seconds when connected to reduce visual clutter
 */
export const ConnectionStatus: React.FC<ConnectionStatusProps> = ({
  connected,
  connecting,
  onRetry,
}) => {
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
