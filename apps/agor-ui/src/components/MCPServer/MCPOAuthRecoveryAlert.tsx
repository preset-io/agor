import { Alert, Button, Space, Typography } from 'antd';
import type { MCPServerOAuthFailure } from './useMCPServerOAuthStart';

interface MCPOAuthRecoveryAlertProps {
  failure: MCPServerOAuthFailure;
  onRetry?: () => void;
  onConfigure?: () => void;
}

export const MCPOAuthRecoveryAlert: React.FC<MCPOAuthRecoveryAlertProps> = ({
  failure,
  onRetry,
  onConfigure,
}) => {
  const action = failure.recovery?.action;
  const configureLabel =
    action === 'configure_client'
      ? 'Configure OAuth client'
      : action === 'review_compatibility' ||
          action === 'review_configuration' ||
          action === 'save_and_retry'
        ? 'Review OAuth settings'
        : undefined;
  const retryLabel = action === 'reauthenticate' ? 'Sign in again' : 'Try again';

  return (
    <Alert
      type="error"
      title={failure.recovery ? 'OAuth setup needs attention' : 'OAuth flow could not start'}
      description={
        <Space orientation="vertical" size={4}>
          <Typography.Text>{failure.message}</Typography.Text>
          <Space>
            {configureLabel && onConfigure && (
              <Button size="small" onClick={onConfigure}>
                {configureLabel}
              </Button>
            )}
            {onRetry && (
              <Button size="small" type={configureLabel ? 'default' : 'primary'} onClick={onRetry}>
                {retryLabel}
              </Button>
            )}
          </Space>
          {action === 'configure_client' && failure.redirectUri && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Register this redirect URL with the provider:{' '}
              <Typography.Text code copyable>
                {failure.redirectUri}
              </Typography.Text>
            </Typography.Text>
          )}
        </Space>
      }
      showIcon
      style={{ marginBottom: 16 }}
    />
  );
};
