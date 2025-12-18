import type { AgorClient } from '@agor/core/api';
import type { VSCodeOpenMode } from '@agor/core/types';
import { Alert, Button, Form, Input, Select, Space, Switch, Typography, theme } from 'antd';
import { useEffect, useState } from 'react';
import { useThemedMessage } from '../../utils/message';

const DEFAULT_CODE_SERVER_TEMPLATE =
  'https://codeserver.example.com/?folder={{encodeURIComponent worktree.path}}';

export interface IDETabProps {
  client: AgorClient | null;
}

export const IDETab: React.FC<IDETabProps> = ({ client }) => {
  const { token } = theme.useToken();
  const { showSuccess, showError } = useThemedMessage();
  const [loading, setLoading] = useState(true);

  const [vscodeEnabled, setVscodeEnabled] = useState(true);
  const [preferredMode, setPreferredMode] = useState<VSCodeOpenMode>('remote-ssh');
  const [remoteHost, setRemoteHost] = useState('');
  const [remotePort, setRemotePort] = useState<string>('');
  const [remoteUser, setRemoteUser] = useState('');
  const [remoteTarget, setRemoteTarget] = useState('');

  const [codeServerEnabled, setCodeServerEnabled] = useState(false);
  const [codeServerTemplate, setCodeServerTemplate] = useState(DEFAULT_CODE_SERVER_TEMPLATE);

  useEffect(() => {
    if (!client) return;

    const loadConfig = async () => {
      try {
        setLoading(true);
        const ideConfig = (await client.service('config').get('ide')) as {
          vscode?: {
            enabled?: boolean;
            preferred_mode?: VSCodeOpenMode;
            remote?: { host?: string; port?: number; user?: string; target?: string };
          };
          code_server?: { enabled?: boolean; url_template?: string };
        };

        if (ideConfig?.vscode) {
          setVscodeEnabled(ideConfig.vscode.enabled !== false);
          setPreferredMode(ideConfig.vscode.preferred_mode || 'remote-ssh');
          setRemoteHost(ideConfig.vscode.remote?.host || '');
          setRemotePort(
            ideConfig.vscode.remote?.port !== undefined ? String(ideConfig.vscode.remote.port) : ''
          );
          setRemoteUser(ideConfig.vscode.remote?.user || '');
          setRemoteTarget(ideConfig.vscode.remote?.target || '');
        }

        if (ideConfig?.code_server) {
          setCodeServerEnabled(ideConfig.code_server.enabled === true);
          setCodeServerTemplate(ideConfig.code_server.url_template || DEFAULT_CODE_SERVER_TEMPLATE);
        }
      } catch (err) {
        console.error('Failed to load IDE config', err);
      } finally {
        setLoading(false);
      }
    };

    loadConfig();
  }, [client]);

  const handleSave = async () => {
    if (!client) return;

    try {
      const portNumber =
        remotePort && !Number.isNaN(Number(remotePort)) ? Number(remotePort) : undefined;

      await client.service('config').patch(null, {
        ide: {
          vscode: {
            enabled: vscodeEnabled,
            preferred_mode: preferredMode,
            remote: {
              host: remoteHost || undefined,
              port: portNumber,
              user: remoteUser || undefined,
              target: remoteTarget || undefined,
            },
          },
          code_server: {
            enabled: codeServerEnabled,
            url_template: codeServerTemplate || undefined,
          },
        },
      });

      showSuccess('IDE configuration saved');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save IDE configuration';
      showError(message);
      console.error('Failed to save IDE config', err);
    }
  };

  return (
    <div style={{ padding: token.paddingMD }}>
      <Alert
        type="info"
        showIcon
        message="VS Code Opening Methods"
        description={
          <div>
            <p style={{ marginBottom: token.marginXS }}>
              Supports <strong>Remote SSH</strong> and local <code>vscode://file</code> methods.
            </p>
            <p style={{ marginBottom: 0 }}>
              Remote SSH is preferred by default; falls back to local method if configuration is
              missing.
            </p>
          </div>
        }
        style={{ marginBottom: token.marginLG }}
      />

      <Form layout="vertical" disabled={loading}>
        <Form.Item label="Enable VS Code Open Button">
          <Space>
            <Switch
              checked={vscodeEnabled}
              onChange={setVscodeEnabled}
              checkedChildren="Enabled"
              unCheckedChildren="Disabled"
            />
            <span style={{ color: token.colorTextSecondary, fontSize: 12 }}>
              Button will be hidden when disabled
            </span>
          </Space>
        </Form.Item>

        <Form.Item label="Preferred Connection Mode">
          <Select<VSCodeOpenMode>
            value={preferredMode}
            onChange={setPreferredMode}
            options={[
              { label: 'Remote SSH', value: 'remote-ssh' },
              { label: 'Local (vscode://file)', value: 'local' },
            ]}
            style={{ width: 240 }}
          />
        </Form.Item>

        <Typography.Title level={5} style={{ marginTop: token.marginLG }}>
          Remote SSH
        </Typography.Title>
        <Form.Item label="Host">
          <Input
            placeholder="example.com"
            value={remoteHost}
            onChange={(e) => setRemoteHost(e.target.value)}
          />
        </Form.Item>
        <Form.Item label="Port">
          <Input
            placeholder="22"
            value={remotePort}
            onChange={(e) => setRemotePort(e.target.value)}
          />
        </Form.Item>
        <Form.Item label="User">
          <Input
            placeholder="dev"
            value={remoteUser}
            onChange={(e) => setRemoteUser(e.target.value)}
          />
        </Form.Item>
        <Form.Item
          label="SSH Target (optional)"
          extra="If using a Host alias from ~/.ssh/config, enter that alias; otherwise leave blank to auto-generate user@host"
        >
          <Input
            placeholder="my-ssh-alias"
            value={remoteTarget}
            onChange={(e) => setRemoteTarget(e.target.value)}
          />
        </Form.Item>

        <Typography.Title level={5} style={{ marginTop: token.marginLG }}>
          code-server (Browser-based)
        </Typography.Title>
        <Form.Item label="Enable code-server Button">
          <Switch checked={codeServerEnabled} onChange={setCodeServerEnabled} />
        </Form.Item>
        <Form.Item
          label="URL Template"
          extra="Use Handlebars variables: worktree, repo; paths are encoded with encodeURIComponent by default"
        >
          <Input.TextArea
            autoSize={{ minRows: 2, maxRows: 4 }}
            placeholder={DEFAULT_CODE_SERVER_TEMPLATE}
            value={codeServerTemplate}
            onChange={(e) => setCodeServerTemplate(e.target.value)}
          />
        </Form.Item>

        <Space style={{ marginTop: token.marginLG }}>
          <Button type="primary" onClick={handleSave} disabled={loading}>
            Save
          </Button>
        </Space>
      </Form>
    </div>
  );
};
