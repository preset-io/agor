import { Alert, Button, Card, Space, Spin, Typography, theme } from 'antd';
import type { CodexAuthStatus } from '../hooks/useCodexAuthStatus';
import type { CodexDeviceAuthFlow } from '../hooks/useCodexDeviceAuth';

const { Paragraph, Text } = Typography;

export interface CodexAuthStatusCardProps {
  status?: CodexAuthStatus | null;
  flow?: CodexDeviceAuthFlow | null;
  loading?: boolean;
  submitting?: boolean;
  error?: string | null;
  onConnect?: () => void;
  onReconnect?: () => void;
  onDisconnect?: () => void;
  onCancel?: () => void;
  onClearError?: () => void;
}

function renderStatusSummary(status: CodexAuthStatus | null | undefined) {
  if (!status) {
    return null;
  }

  switch (status.status) {
    case 'signed_in_with_chatgpt':
      return (
        <Alert
          type="success"
          title="Connected to Codex"
          description="This user can use Codex with their ChatGPT subscription."
          showIcon
        />
      );
    case 'using_api_key':
      return (
        <Alert
          type="warning"
          title="Using OpenAI API key"
          description="Remove the configured OPENAI_API_KEY if you want to use Codex login instead."
          showIcon
        />
      );
    default:
      return (
        <Paragraph style={{ marginBottom: 0 }}>
          Connect Codex to use your ChatGPT subscription in Agor.
        </Paragraph>
      );
  }
}

export function CodexAuthStatusCard({
  status,
  flow,
  loading = false,
  submitting = false,
  error,
  onConnect,
  onReconnect,
  onDisconnect,
  onCancel,
  onClearError,
}: CodexAuthStatusCardProps) {
  const { token } = theme.useToken();

  return (
    <Card title="Codex" size="small">
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        {loading && !status ? (
          <div style={{ textAlign: 'center', padding: token.paddingSM }}>
            <Spin />
          </div>
        ) : null}

        {error ? (
          <Alert type="error" title={error} showIcon closable onClose={onClearError} />
        ) : null}

        {renderStatusSummary(status)}

        {flow?.status === 'pending' ? (
          <Alert
            type="info"
            showIcon
            title="Complete login in your browser"
            description={
              <Space orientation="vertical" size="small">
                <Paragraph style={{ marginBottom: 0 }}>
                  Open the verification URL and enter the code below.
                </Paragraph>
                {flow.verificationUri ? <Text code>{flow.verificationUri}</Text> : null}
                {flow.userCode ? <Text code>{flow.userCode}</Text> : null}
                <Button onClick={onCancel} loading={submitting}>
                  Cancel login
                </Button>
              </Space>
            }
          />
        ) : null}

        {flow?.status === 'failed' && flow.error ? (
          <Alert type="error" showIcon title="Codex login failed" description={flow.error} />
        ) : null}

        {flow?.status !== 'pending' ? (
          <Space wrap>
            {status?.status === 'signed_in_with_chatgpt' ? (
              <>
                <Button onClick={onReconnect} loading={submitting}>
                  Reconnect Codex
                </Button>
                <Button danger onClick={onDisconnect} loading={submitting}>
                  Disconnect Codex
                </Button>
              </>
            ) : null}

            {status?.status === 'not_signed_in' || status?.status === 'unknown' || !status ? (
              <Button type="primary" onClick={onConnect} loading={submitting}>
                Connect Codex
              </Button>
            ) : null}
          </Space>
        ) : null}
      </Space>
    </Card>
  );
}
