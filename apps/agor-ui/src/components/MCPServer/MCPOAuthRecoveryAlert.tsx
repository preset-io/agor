import { Alert, Button, Space, Typography } from 'antd';
import { MCPOAuthPolicySummary } from './MCPOAuthPolicySummary';
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
  const hasDescription = !!(failure.recovery || failure.detail || onRetry || onConfigure);

  return (
    <Alert
      type={failure.severity ?? 'error'}
      // Without a recovery the message is the whole story, so it leads.
      title={failure.recovery ? 'OAuth setup needs attention' : failure.message}
      description={
        hasDescription && (
          <Space orientation="vertical" size={4}>
            {failure.recovery && <Typography.Text>{failure.message}</Typography.Text>}
            {failure.detail && (
              <Typography.Text type="secondary">
                Error: <Typography.Text code>{failure.detail}</Typography.Text>
              </Typography.Text>
            )}
            {failure.recovery?.failure_reason && (
              <Typography.Text type="secondary">
                Reason: <Typography.Text code>{failure.recovery.failure_reason}</Typography.Text>
              </Typography.Text>
            )}
            {failure.recovery?.oauth_policy && (
              <MCPOAuthPolicySummary
                policy={failure.recovery.oauth_policy}
                label="Policy at failure"
              />
            )}
            <Space>
              {configureLabel && onConfigure && (
                <Button size="small" onClick={onConfigure}>
                  {configureLabel}
                </Button>
              )}
              {onRetry && (
                <Button
                  size="small"
                  type={configureLabel ? 'default' : 'primary'}
                  onClick={onRetry}
                >
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
        )
      }
      showIcon
      style={{ marginBottom: 16 }}
    />
  );
};
