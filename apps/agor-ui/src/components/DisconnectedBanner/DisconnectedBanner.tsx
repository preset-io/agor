import { Alert, Button } from 'antd';
import { useMutationGate } from '../../contexts/ConnectionContext';

export interface DisconnectedBannerProps {
  /** Optional manual-retry callback. If omitted, retry button is hidden. */
  onRetry?: () => void;
}

/**
 * DisconnectedBanner - slim full-width app-shell banner that makes the
 * disconnected state unmissable without blocking interaction.
 *
 * Mounted once at the App root, immediately above the route tree. Renders
 * nothing when the connection is healthy. Pure-read interactions (panning
 * the canvas, opening modals) remain available — only server-mutating
 * actions are gated, via <MutateButton> / useMutationGate().
 */
export const DisconnectedBanner: React.FC<DisconnectedBannerProps> = ({ onRetry }) => {
  const gate = useMutationGate();
  if (gate.canMutate) return null;

  const isReconnecting = gate.reason === 'reconnecting';
  const isOutOfSync = gate.reason === 'out-of-sync';

  let message: string;
  if (isOutOfSync) {
    message = 'Daemon was upgraded — refresh to continue.';
  } else if (isReconnecting) {
    message = 'Reconnecting to daemon… read-only mode.';
  } else {
    message = 'Disconnected from daemon — read-only mode.';
  }

  let action: React.ReactNode = null;
  if (isOutOfSync) {
    action = (
      <Button size="small" onClick={() => window.location.reload()}>
        Refresh
      </Button>
    );
  } else if (!isReconnecting && onRetry) {
    action = (
      <Button size="small" onClick={onRetry}>
        Retry
      </Button>
    );
  }

  return (
    <Alert
      type={isOutOfSync ? 'warning' : 'error'}
      banner
      showIcon
      message={message}
      action={action}
    />
  );
};
