import { CloudOutlined, InfoCircleOutlined, SettingOutlined } from '@ant-design/icons';
import { Alert, Button, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { copyToClipboard } from '../utils/clipboard';

export function SandboxBanner() {
  const isCodespaces = import.meta.env.VITE_CODESPACES === 'true';
  const [showSetupReminder, setShowSetupReminder] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Check if sandbox warning was previously dismissed
    const wasDismissed = localStorage.getItem('agor-sandbox-dismissed') === 'true';
    setDismissed(wasDismissed);

    // Check if API keys are set or if we're in anonymous mode
    // This is a simple heuristic - real check would ping daemon config
    const hasAnthropicKey = !!import.meta.env.ANTHROPIC_API_KEY;
    const hasOpenAIKey = !!import.meta.env.OPENAI_API_KEY;

    // Show reminder if no keys detected
    if (!hasAnthropicKey && !hasOpenAIKey) {
      setShowSetupReminder(true);
    }
  }, []);

  if (!isCodespaces) return null;

  return (
    <>
      {/* Main sandbox warning */}
      {!dismissed && (
        <Alert
          banner
          type="warning"
          icon={<CloudOutlined />}
          message={
            <Space>
              <Typography.Text strong>🧪 Sandbox Mode - GitHub Codespaces</Typography.Text>
              <Typography.Text type="secondary">
                Data is ephemeral. Avoid sensitive data.
              </Typography.Text>
              <Button
                size="small"
                icon={<InfoCircleOutlined />}
                onClick={() => {
                  window.open('https://github.com/codespaces', '_blank');
                }}
              >
                Manage Visibility
              </Button>
            </Space>
          }
          closable
          onClose={() => {
            setDismissed(true);
            localStorage.setItem('agor-sandbox-dismissed', 'true');
          }}
        />
      )}

      {/* Setup reminder (only if not configured) */}
      {showSetupReminder && (
        <Alert
          banner
          type="info"
          icon={<SettingOutlined />}
          message={
            <Space>
              <Typography.Text>
                Run <code>pnpm agor init</code> in the terminal to set up authentication and API
                keys
              </Typography.Text>
              <Button size="small" onClick={() => copyToClipboard('pnpm agor init')}>
                Copy Command
              </Button>
            </Space>
          }
          closable
          onClose={() => setShowSetupReminder(false)}
        />
      )}
    </>
  );
}
