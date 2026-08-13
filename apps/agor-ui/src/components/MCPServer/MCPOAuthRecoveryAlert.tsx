import { Alert, Button, Space, Typography } from 'antd';
import type { MCPServerOAuthFailure } from './useMCPServerOAuthStart';

interface MCPOAuthRecoveryAlertProps {
  failure: MCPServerOAuthFailure;
  onOpenSettings: () => void;
}

export const MCPOAuthRecoveryAlert: React.FC<MCPOAuthRecoveryAlertProps> = ({
  failure,
  onOpenSettings,
}) => {
  const isDcrFailure = failure.diagnostic !== undefined;

  return (
    <Alert
      type="error"
      title={isDcrFailure ? 'OAuth setup needs attention' : 'OAuth flow could not start'}
      description={
        <Space orientation="vertical" size={4}>
          <Typography.Text>{failure.message}</Typography.Text>
          {failure.diagnostic && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Stage: {failure.diagnostic.stage.replaceAll('_', ' ')}
              {failure.diagnostic.http_status !== undefined
                ? ` · HTTP ${failure.diagnostic.http_status}`
                : ''}
            </Typography.Text>
          )}
          {isDcrFailure && failure.redirectUri && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Register this redirect URL with the provider:{' '}
              <Typography.Text code copyable>
                {failure.redirectUri}
              </Typography.Text>
            </Typography.Text>
          )}
        </Space>
      }
      action={
        isDcrFailure ? (
          <Button size="small" onClick={onOpenSettings}>
            Open OAuth settings
          </Button>
        ) : undefined
      }
      showIcon
      style={{ marginBottom: 16 }}
    />
  );
};
