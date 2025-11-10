import { GlobalOutlined, WarningOutlined } from '@ant-design/icons';
import { Alert, Space, Switch, Typography } from 'antd';

export interface CodexNetworkAccessToggleProps {
  /** Value passed by parent Form.Item (legacy `value` or Switch-friendly `checked`) */
  value?: boolean;
  checked?: boolean;
  onChange?: (value: boolean) => void;
  /** Show detailed security warning */
  showWarning?: boolean;
}

/**
 * Toggle for Codex network access configuration
 *
 * Controls [sandbox_workspace_write].network_access in config.toml.
 * Only applies when sandboxMode = 'workspace-write'.
 */
export const CodexNetworkAccessToggle: React.FC<CodexNetworkAccessToggleProps> = ({
  value,
  checked,
  onChange,
  showWarning = true,
}) => {
  const isEnabled = typeof checked === 'boolean' ? checked : !!value;

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Space>
        <Switch
          checked={isEnabled}
          onChange={onChange}
          checkedChildren={<GlobalOutlined />}
          unCheckedChildren={<GlobalOutlined />}
        />
        <Typography.Text strong>Enable Network Access</Typography.Text>
        <Typography.Text type="secondary">(workspace-write sandbox only)</Typography.Text>
      </Space>

      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
        {isEnabled
          ? 'Allows outbound HTTP/HTTPS requests for package installation and API calls'
          : 'Network access disabled (default, most secure)'}
      </Typography.Text>

      {showWarning && isEnabled && (
        <Alert
          message="Security Warning"
          description={
            <div>
              Enabling network access exposes your environment to:
              <ul style={{ marginTop: 8, marginBottom: 0, paddingLeft: 20 }}>
                <li>Prompt injection attacks</li>
                <li>Data exfiltration of code/secrets</li>
                <li>Inclusion of malware or vulnerable dependencies</li>
              </ul>
              Only enable for trusted tasks.
            </div>
          }
          type="warning"
          icon={<WarningOutlined />}
          showIcon
          style={{ marginTop: 8 }}
        />
      )}
    </Space>
  );
};
