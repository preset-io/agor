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
  onCancel?: () => void;
  onClearError?: () => void;
}

function getAlertType(status: CodexAuthStatus | null | undefined): 'info' | 'success' | 'warning' {
  if (!status) {
    return 'info';
  }

  switch (status.status) {
    case 'signed_in_with_chatgpt':
      return 'success';
    case 'using_api_key':
      return 'warning';
    default:
      return 'info';
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
  onCancel,
  onClearError,
}: CodexAuthStatusCardProps) {
  const { token } = theme.useToken();

  return (
    <Card title="Codex Login" size="small">
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        {loading && !status ? (
          <div style={{ textAlign: 'center', padding: token.paddingSM }}>
            <Spin />
          </div>
        ) : null}

        {error ? (
          <Alert type="error" title={error} showIcon closable onClose={onClearError} />
        ) : null}

        {status ? (
          <>
            <Alert
              type={getAlertType(status)}
              title={status.label}
              description={status.description}
              showIcon
            />

            {status.status === 'using_api_key' ? (
              <Alert
                type="warning"
                showIcon
                title="API key precedence"
                description="Configured OPENAI_API_KEY values will take precedence over ChatGPT or Codex CLI login."
              />
            ) : null}

            {status.warnings.map((warning) => (
              <Alert key={warning} type="warning" showIcon title={warning} />
            ))}

            {status.guidance.length > 0 ? (
              <div>
                <Text strong>How to connect</Text>
                <ul
                  style={{
                    marginTop: token.marginXS,
                    marginBottom: 0,
                    paddingLeft: token.paddingLG,
                  }}
                >
                  {status.guidance.map((guidance) => (
                    <li key={guidance}>{guidance}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              Stable Codex home: <Text code>{status.codexHome}</Text>
            </Paragraph>
          </>
        ) : null}

        {flow?.status === 'pending' ? (
          <Alert
            type="info"
            showIcon
            title="Complete login in your browser"
            description={
              <Space orientation="vertical" size="small">
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
              <Button onClick={onReconnect} loading={submitting}>
                Reconnect Codex
              </Button>
            ) : null}

            {status?.status === 'not_signed_in' || status?.status === 'unknown' ? (
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
