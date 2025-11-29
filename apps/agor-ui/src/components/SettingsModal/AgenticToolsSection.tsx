/**
 * Agentic Tools Section
 *
 * Top-level tab containing nested tabs for each agentic tool (Claude Code, Codex, Gemini, OpenCode).
 * Each tool tab displays its API key configuration and tool-specific settings.
 */

import type { AgorClient } from '@agor/core/api';
import type { AgorConfig } from '@agor/core/config';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  InfoCircleOutlined,
  LoadingOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Alert, Button, Form, Input, Space, Spin, Switch, Tabs, Tooltip, theme } from 'antd';
import { useEffect, useState } from 'react';
import { useThemedMessage } from '../../utils/message';
import { ApiKeyFields, type ApiKeyStatus } from '../ApiKeyFields';

export interface AgenticToolsSectionProps {
  client: AgorClient | null;
}

// Helper component for API key tabs
const ApiKeyTabContent: React.FC<{
  keyField: keyof ApiKeyStatus;
  keyStatus: Partial<ApiKeyStatus>;
  keysError: string | null;
  savingKeys: Record<string, boolean>;
  onSave: (field: keyof ApiKeyStatus, value: string) => Promise<void>;
  onClear: (field: keyof ApiKeyStatus) => Promise<void>;
  onClearError: () => void;
}> = ({ keyField, keyStatus, keysError, savingKeys, onSave, onClear, onClearError }) => {
  const { token } = theme.useToken();

  return (
    <div style={{ paddingTop: token.paddingMD }}>
      <Alert
        message={
          <span>
            This is the <strong>global API key</strong> for all users. Per-user keys can be set in
            the Users tab.{' '}
            <a
              href="https://agor.live/guide/authentication"
              target="_blank"
              rel="noopener noreferrer"
            >
              Learn more →
            </a>
          </span>
        }
        type="info"
        showIcon
        style={{ marginBottom: token.marginLG }}
      />

      {keysError && (
        <Alert
          message={keysError}
          type="error"
          icon={<WarningOutlined />}
          showIcon
          closable
          onClose={onClearError}
          style={{ marginBottom: token.marginLG }}
        />
      )}

      <ApiKeyFields
        keyStatus={{ [keyField]: keyStatus[keyField] }}
        onSave={onSave}
        onClear={onClear}
        saving={savingKeys}
      />
    </div>
  );
};

export const AgenticToolsSection: React.FC<AgenticToolsSectionProps> = ({ client }) => {
  const { token } = theme.useToken();
  const { showSuccess, showError } = useThemedMessage();

  // Shared API keys state
  const [loadingKeys, setLoadingKeys] = useState(true);
  const [savingKeys, setSavingKeys] = useState<Record<string, boolean>>({});
  const [keysError, setKeysError] = useState<string | null>(null);
  const [keyStatus, setKeyStatus] = useState<ApiKeyStatus>({
    ANTHROPIC_API_KEY: false,
    OPENAI_API_KEY: false,
    GEMINI_API_KEY: false,
  });

  // OpenCode state
  const [opencodeForm] = Form.useForm();
  const [opencodeEnabled, setOpencodeEnabled] = useState(false);
  const [opencodeServerUrl, setOpencodeServerUrl] = useState('http://localhost:4096');
  const [opencodeConnected, setOpencodeConnected] = useState<boolean | null>(null);
  const [opencodeTesting, setOpencodeTesting] = useState(false);
  const [loadingOpencode, setLoadingOpencode] = useState(true);
  const defaultCodexHome = '~/.agor/codex';
  const [codexHome, setCodexHome] = useState(defaultCodexHome);
  const [initialCodexHome, setInitialCodexHome] = useState(defaultCodexHome);
  const [loadingCodexConfig, setLoadingCodexConfig] = useState(true);
  const [savingCodexHome, setSavingCodexHome] = useState(false);

  // Load API keys configuration
  useEffect(() => {
    if (!client) return;

    const loadKeys = async () => {
      try {
        setLoadingKeys(true);
        setKeysError(null);

        const config = (await client.service('config').get('credentials')) as
          | AgorConfig['credentials']
          | undefined;

        setKeyStatus({
          ANTHROPIC_API_KEY: !!config?.ANTHROPIC_API_KEY,
          OPENAI_API_KEY: !!config?.OPENAI_API_KEY,
          GEMINI_API_KEY: !!config?.GEMINI_API_KEY,
        });
      } catch (err) {
        console.error('Failed to load API keys:', err);
        setKeysError(err instanceof Error ? err.message : 'Failed to load API keys');
      } finally {
        setLoadingKeys(false);
      }
    };

    loadKeys();
  }, [client]);

  // Load OpenCode configuration
  useEffect(() => {
    if (!client) return;

    const loadOpenCode = async () => {
      try {
        setLoadingOpencode(true);

        // biome-ignore lint/suspicious/noExplicitAny: Config service returns dynamic object
        const config = (await client.service('config').get('opencode')) as any;

        if (config) {
          setOpencodeEnabled(config.enabled || false);
          setOpencodeServerUrl(config.serverUrl || 'http://localhost:4096');
        }
      } catch (err) {
        console.error('Failed to load OpenCode config:', err);
      } finally {
        setLoadingOpencode(false);
      }
    };

    loadOpenCode();
  }, [client]);

  // Load Codex configuration
  useEffect(() => {
    if (!client) return;

    const loadCodex = async () => {
      try {
        setLoadingCodexConfig(true);
        const config = (await client.service('config').get('codex')) as { home?: string } | null;
        const home = config?.home || defaultCodexHome;
        setCodexHome(home);
        setInitialCodexHome(home);
      } catch (err) {
        console.error('Failed to load Codex config:', err);
        setCodexHome(defaultCodexHome);
        setInitialCodexHome(defaultCodexHome);
      } finally {
        setLoadingCodexConfig(false);
      }
    };

    loadCodex();
  }, [client]);

  // Save API key
  const handleSaveKey = async (field: keyof ApiKeyStatus, value: string) => {
    if (!client) return;

    try {
      setSavingKeys((prev) => ({ ...prev, [field]: true }));
      setKeysError(null);

      await client.service('config').patch(null, {
        credentials: {
          [field]: value,
        },
      });

      setKeyStatus((prev) => ({ ...prev, [field]: true }));
    } catch (err) {
      console.error(`Failed to save ${field}:`, err);
      setKeysError(err instanceof Error ? err.message : `Failed to save ${field}`);
      throw err;
    } finally {
      setSavingKeys((prev) => ({ ...prev, [field]: false }));
    }
  };

  // Clear API key
  const handleClearKey = async (field: keyof ApiKeyStatus) => {
    if (!client) return;

    try {
      setSavingKeys((prev) => ({ ...prev, [field]: true }));
      setKeysError(null);

      await client.service('config').patch(null, {
        credentials: {
          [field]: null,
        },
      });

      setKeyStatus((prev) => ({ ...prev, [field]: false }));
    } catch (err) {
      console.error(`Failed to clear ${field}:`, err);
      setKeysError(err instanceof Error ? err.message : `Failed to clear ${field}`);
      throw err;
    } finally {
      setSavingKeys((prev) => ({ ...prev, [field]: false }));
    }
  };

  const handleSaveCodexHome = async () => {
    if (!client) return;

    const trimmed = codexHome.trim();
    if (!trimmed) {
      showError('Codex home directory cannot be empty');
      return;
    }

    try {
      setSavingCodexHome(true);
      await client.service('config').patch(null, {
        codex: {
          home: trimmed,
        },
      });
      setInitialCodexHome(trimmed);
      showSuccess('Codex home updated');
    } catch (err) {
      console.error('Failed to save Codex home:', err);
      showError(err instanceof Error ? err.message : 'Failed to save Codex home');
    } finally {
      setSavingCodexHome(false);
    }
  };

  // Test OpenCode connection
  const handleTestOpenCodeConnection = async () => {
    if (!client) return;

    setOpencodeTesting(true);

    try {
      // biome-ignore lint/suspicious/noExplicitAny: Health check returns dynamic result
      const result = (await client.service('opencode/health').find()) as any;
      setOpencodeConnected(result.connected === true);
    } catch (error) {
      console.error('[OpenCode] Health check error:', error);
      setOpencodeConnected(false);
    } finally {
      setOpencodeTesting(false);
    }
  };

  // Save OpenCode configuration
  const handleSaveOpenCode = async () => {
    if (!client) return;

    try {
      await client.service('config').patch(null, {
        opencode: {
          enabled: opencodeEnabled,
          serverUrl: opencodeServerUrl,
        },
      });

      showSuccess('OpenCode settings saved successfully');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to save OpenCode settings';
      showError(errorMsg);
      console.error('Failed to save OpenCode settings:', err);
    }
  };

  const codexHomeChanged = codexHome !== initialCodexHome;
  const loading = loadingKeys || loadingOpencode || loadingCodexConfig;

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: token.paddingLG }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div style={{ padding: token.paddingMD }}>
      {/* Nested tabs for each tool */}
      <Tabs
        defaultActiveKey="claude-code"
        items={[
          {
            key: 'claude-code',
            label: 'Claude Code',
            children: (
              <ApiKeyTabContent
                keyField="ANTHROPIC_API_KEY"
                keyStatus={keyStatus}
                keysError={keysError}
                savingKeys={savingKeys}
                onSave={handleSaveKey}
                onClear={handleClearKey}
                onClearError={() => setKeysError(null)}
              />
            ),
          },
          {
            key: 'codex',
            label: 'Codex',
            children: (
              <div
                style={{
                  paddingTop: token.paddingMD,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: token.marginXL,
                }}
              >
                <ApiKeyTabContent
                  keyField="OPENAI_API_KEY"
                  keyStatus={keyStatus}
                  keysError={keysError}
                  savingKeys={savingKeys}
                  onSave={handleSaveKey}
                  onClear={handleClearKey}
                  onClearError={() => setKeysError(null)}
                />

                <Form layout="vertical">
                  <Form.Item
                    label="Codex home directory"
                    extra="Agor sets CODEX_HOME before launching Codex. Point this at another directory to reuse an existing Codex configuration."
                  >
                    <Input
                      value={codexHome}
                      onChange={(event) => setCodexHome(event.target.value)}
                      placeholder={defaultCodexHome}
                    />
                  </Form.Item>
                  <Space>
                    <Button
                      type="primary"
                      onClick={handleSaveCodexHome}
                      disabled={!codexHomeChanged}
                      loading={savingCodexHome}
                    >
                      Save Codex home
                    </Button>
                    <Button
                      onClick={() => setCodexHome(defaultCodexHome)}
                      disabled={codexHome === defaultCodexHome}
                    >
                      Reset to default
                    </Button>
                  </Space>
                </Form>
              </div>
            ),
          },
          {
            key: 'gemini',
            label: 'Gemini',
            children: (
              <ApiKeyTabContent
                keyField="GEMINI_API_KEY"
                keyStatus={keyStatus}
                keysError={keysError}
                savingKeys={savingKeys}
                onSave={handleSaveKey}
                onClear={handleClearKey}
                onClearError={() => setKeysError(null)}
              />
            ),
          },
          {
            key: 'opencode',
            label: 'OpenCode',
            children: (
              <div style={{ paddingTop: token.paddingMD }}>
                {/* OpenCode Info */}
                <Alert
                  message="OpenCode.ai Integration"
                  description={
                    <div>
                      <p style={{ marginBottom: token.marginXS }}>
                        OpenCode provides access to <strong>75+ LLM providers</strong> including
                        local models, custom endpoints, and privacy-focused options.
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
                <Form form={opencodeForm} layout="vertical">
                  {/* Enable Toggle */}
                  <Form.Item label="Enable OpenCode Integration">
                    <Space>
                      <Switch
                        checked={opencodeEnabled}
                        onChange={setOpencodeEnabled}
                        checkedChildren="Enabled"
                        unCheckedChildren="Disabled"
                      />
                      <span style={{ color: token.colorTextSecondary, fontSize: 12 }}>
                        Enable OpenCode as an agentic tool option in Agor
                      </span>
                    </Space>
                  </Form.Item>

                  {opencodeEnabled && (
                    <>
                      {/* Server URL */}
                      <Form.Item
                        label="OpenCode Server URL"
                        help="URL where OpenCode server is running (started with 'opencode serve')"
                      >
                        <Space.Compact style={{ width: '100%' }}>
                          <Input
                            placeholder="http://localhost:4096"
                            value={opencodeServerUrl}
                            onChange={(e) => setOpencodeServerUrl(e.target.value)}
                          />
                          <Tooltip title="Test connection to OpenCode server">
                            <Button
                              loading={opencodeTesting}
                              icon={opencodeTesting ? <LoadingOutlined /> : undefined}
                              onClick={handleTestOpenCodeConnection}
                            >
                              Test
                            </Button>
                          </Tooltip>
                        </Space.Compact>
                      </Form.Item>

                      {/* Connection Status */}
                      {opencodeConnected !== null && (
                        <Alert
                          message={
                            opencodeConnected ? (
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
                          type={opencodeConnected ? 'success' : 'error'}
                          showIcon={false}
                          style={{ marginBottom: token.marginLG }}
                        />
                      )}

                      {/* Setup Instructions (shown if not connected) */}
                      {opencodeConnected === false && (
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
                                <a
                                  href="https://opencode.ai/docs"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
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
                      {opencodeConnected === true && (
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
                    <Button type="primary" onClick={handleSaveOpenCode}>
                      Save OpenCode Settings
                    </Button>
                  </Form.Item>
                </Form>

                {/* Information Section */}
                <div style={{ marginTop: token.marginLG }}>
                  <h4>About OpenCode</h4>
                  <ul style={{ fontSize: 12, lineHeight: 1.8, color: token.colorTextSecondary }}>
                    <li>
                      <strong>Multi-Provider Support:</strong> Access Claude, GPT-4, Gemini, and 70+
                      other models
                    </li>
                    <li>
                      <strong>Privacy-First:</strong> All code and context stays local - no cloud
                      storage
                    </li>
                    <li>
                      <strong>Local Models:</strong> Support for Ollama, LM Studio, and custom
                      endpoints
                    </li>
                    <li>
                      <strong>Open Source:</strong> 30K+ GitHub stars, active community
                    </li>
                  </ul>
                </div>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
};
