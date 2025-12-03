/**
 * OpenCode Settings Tab
 *
 * Allows users to enable/disable OpenCode integration and configure server URL.
 * Includes connection testing and setup instructions.
 */

import type { AgorClient } from '@agor/core/api';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  InfoCircleOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import { Alert, Button, Form, Input, Space, Spin, Switch, Tooltip, theme } from 'antd';
import { useEffect, useState } from 'react';
import { useThemedMessage } from '../../utils/message';

export interface OpenCodeTabProps {
  client: AgorClient | null;
}

export const OpenCodeTab: React.FC<OpenCodeTabProps> = ({ client }) => {
  const { token } = theme.useToken();
  const { showSuccess, showError } = useThemedMessage();
  const [form] = Form.useForm();

  // State
  const [enabled, setEnabled] = useState(false);
  const [serverUrl, setServerUrl] = useState('http://localhost:4096');
  const [isConnected, setIsConnected] = useState<boolean | null>(null);
  const [testing, setTesting] = useState(false);
  const [loading, setLoading] = useState(true);

  // Load configuration on mount
  useEffect(() => {
    if (!client) return;

    const loadConfig = async () => {
      try {
        setLoading(true);

        // Get OpenCode config from daemon
        const config = (await client.service('config').get('opencode')) as {
          enabled?: boolean;
          serverUrl?: string;
        };

        if (config) {
          setEnabled(config.enabled || false);
          setServerUrl(config.serverUrl || 'http://localhost:4096');
        }
      } catch (err) {
        console.error('Failed to load OpenCode config:', err);
      } finally {
        setLoading(false);
      }
    };

    loadConfig();
  }, [client]);

  // Test connection to OpenCode server (via daemon proxy)
  const handleTestConnection = async () => {
    if (!client) return;

    setTesting(true);

    try {
      // Use daemon endpoint to proxy the health check
      // Pass the current serverUrl from frontend state (not the saved config)
      const result = (await client.service('opencode/health').find({
        query: {
          serverUrl: serverUrl,
        },
      })) as {
        connected?: boolean;
      };
      setIsConnected(result.connected === true);
    } catch (error) {
      console.error('[OpenCodeTab] Health check error:', error);
      setIsConnected(false);
    } finally {
      setTesting(false);
    }
  };

  // Save configuration
  const handleSave = async () => {
    if (!client) return;

    try {
      await client.service('config').patch(null, {
        opencode: {
          enabled,
          serverUrl,
        },
      });

      showSuccess('OpenCode settings saved successfully');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to save OpenCode settings';
      showError(errorMsg);
      console.error('Failed to save OpenCode settings:', err);
    }
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: token.paddingLG }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div style={{ padding: token.paddingMD }}>
      {/* Information Alert */}
      <Alert
        message="OpenCode.ai Integration"
        description={
          <div>
            <p style={{ marginBottom: token.marginXS }}>
              OpenCode provides access to <strong>75+ LLM providers</strong> including local models,
              custom endpoints, and privacy-focused options.
            </p>
            <p style={{ marginBottom: 0 }}>
              To use OpenCode sessions, you must run the OpenCode server separately.{' '}
              <a
                href="https://agor.live/guide/opencode-setup"
                target="_blank"
                rel="noopener noreferrer"
              >
                Setup Guide →
              </a>
            </p>
          </div>
        }
        type="info"
        icon={<InfoCircleOutlined />}
        showIcon
        style={{ marginBottom: token.marginLG }}
      />

      {/* Configuration Form */}
      <Form form={form} layout="vertical">
        {/* Enable Toggle */}
        <Form.Item label="Enable OpenCode Integration">
          <Space>
            <Switch
              checked={enabled}
              onChange={setEnabled}
              checkedChildren="Enabled"
              unCheckedChildren="Disabled"
            />
            <span style={{ color: token.colorTextSecondary, fontSize: 12 }}>
              Enable OpenCode as an agentic tool option in Agor
            </span>
          </Space>
        </Form.Item>

        {enabled && (
          <>
            {/* Server URL */}
            <Form.Item
              label="OpenCode Server URL"
              help="URL where OpenCode server is running (started with 'opencode serve')"
              rules={[
                { required: true, message: 'Server URL is required' },
                { type: 'url', message: 'Must be a valid URL' },
              ]}
            >
              <Space.Compact style={{ width: '100%' }}>
                <Input
                  placeholder="http://localhost:4096"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  style={{ width: '100%' }}
                />
                <Tooltip title="Test connection to OpenCode server">
                  <Button
                    size="small"
                    type="text"
                    loading={testing}
                    icon={testing ? <LoadingOutlined /> : undefined}
                    onClick={handleTestConnection}
                  >
                    Test
                  </Button>
                </Tooltip>
              </Space.Compact>
            </Form.Item>

            {/* Connection Status */}
            {isConnected !== null && (
              <Alert
                message={
                  isConnected ? (
                    <Space>
                      <CheckCircleOutlined style={{ color: token.colorSuccess }} />
                      <span>Connected to OpenCode server</span>
                    </Space>
                  ) : (
                    <Space>
                      <CloseCircleOutlined style={{ color: token.colorError }} />
                      <span>Cannot connect to OpenCode server</span>
                    </Space>
                  )
                }
                type={isConnected ? 'success' : 'error'}
                showIcon={false}
                style={{ marginBottom: token.marginLG }}
              />
            )}

            {/* Setup Instructions (shown if not connected) */}
            {isConnected === false && (
              <Alert
                message="Server Not Running"
                description={
                  <div>
                    <p style={{ marginBottom: token.marginXS }}>
                      Start OpenCode server in a separate terminal:
                    </p>
                    <pre
                      style={{
                        background: token.colorBgContainer,
                        padding: token.paddingXS,
                        borderRadius: token.borderRadius,
                        border: `1px solid ${token.colorBorder}`,
                        overflowX: 'auto',
                        marginBottom: token.marginXS,
                        fontSize: 12,
                      }}
                    >
                      opencode serve --port 4096
                    </pre>
                    <p style={{ marginBottom: 0, fontSize: 12 }}>
                      Don't have OpenCode?{' '}
                      <a href="https://opencode.ai/docs" target="_blank" rel="noopener noreferrer">
                        Installation Guide →
                      </a>
                    </p>
                  </div>
                }
                type="warning"
                showIcon
                style={{ marginBottom: token.marginLG }}
              />
            )}

            {/* Success Status */}
            {isConnected === true && (
              <Alert
                message="Ready to use!"
                description="You can now create sessions with OpenCode as the agentic tool."
                type="success"
                showIcon
                style={{ marginBottom: token.marginLG }}
              />
            )}
          </>
        )}

        {/* Save Button */}
        <Form.Item>
          <Button type="primary" onClick={handleSave}>
            Save OpenCode Settings
          </Button>
        </Form.Item>
      </Form>

      {/* Information Section */}
      <div style={{ marginTop: token.marginLG }}>
        <h4>About OpenCode</h4>
        <ul style={{ fontSize: 12, lineHeight: 1.8, color: token.colorTextSecondary }}>
          <li>
            <strong>Multi-Provider Support:</strong> Access Claude, GPT-4, Gemini, and 70+ other
            models
          </li>
          <li>
            <strong>Privacy-First:</strong> All code and context stays local - no cloud storage
          </li>
          <li>
            <strong>Local Models:</strong> Support for Ollama, LM Studio, and custom endpoints
          </li>
          <li>
            <strong>Open Source:</strong> 30K+ GitHub stars, active community
          </li>
        </ul>
      </div>
    </div>
  );
};
