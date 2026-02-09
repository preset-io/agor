import type { AgorClient } from '@agor/core/api';
import type { AgorConfig } from '@agor/core/config';
import { InfoCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { Alert, Button, Divider, Input, Space, Spin, Typography, theme } from 'antd';
import { useEffect, useState } from 'react';
import { ApiKeyFields, type ApiKeyStatus } from '../ApiKeyFields';

const { Text, Link } = Typography;

export interface AgenticToolsTabProps {
  client: AgorClient | null;
}

export const AgenticToolsTab: React.FC<AgenticToolsTabProps> = ({ client }) => {
  const { token } = theme.useToken();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [keyStatus, setKeyStatus] = useState<ApiKeyStatus>({
    ANTHROPIC_API_KEY: false,
    OPENAI_API_KEY: false,
    GEMINI_API_KEY: false,
  });
  const [baseUrl, setBaseUrl] = useState<string>('');
  const [baseUrlInput, setBaseUrlInput] = useState<string>('');

  // Load current config on mount
  useEffect(() => {
    if (!client) return;

    const loadConfig = async () => {
      try {
        setLoading(true);
        setError(null);

        // Get credentials section from config service
        const config = (await client.service('config').get('credentials')) as
          | AgorConfig['credentials']
          | undefined;

        // Check which keys are set (truthy values mean key exists)
        setKeyStatus({
          ANTHROPIC_API_KEY: !!config?.ANTHROPIC_API_KEY,
          OPENAI_API_KEY: !!config?.OPENAI_API_KEY,
          GEMINI_API_KEY: !!config?.GEMINI_API_KEY,
        });

        // Load base URL if set
        setBaseUrl(config?.ANTHROPIC_BASE_URL || '');
        setBaseUrlInput(config?.ANTHROPIC_BASE_URL || '');
      } catch (err) {
        console.error('Failed to load config:', err);
        setError(err instanceof Error ? err.message : 'Failed to load configuration');
      } finally {
        setLoading(false);
      }
    };

    loadConfig();
  }, [client]);

  // Save handler
  const handleSave = async (field: keyof ApiKeyStatus, value: string) => {
    if (!client) return;

    try {
      setSaving((prev) => ({ ...prev, [field]: true }));
      setError(null);

      await client.service('config').patch(null, {
        credentials: {
          [field]: value,
        },
      });

      setKeyStatus((prev) => ({ ...prev, [field]: true }));
    } catch (err) {
      console.error(`Failed to save ${field}:`, err);
      setError(err instanceof Error ? err.message : `Failed to save ${field}`);
      throw err;
    } finally {
      setSaving((prev) => ({ ...prev, [field]: false }));
    }
  };

  // Clear handler
  const handleClear = async (field: keyof ApiKeyStatus) => {
    if (!client) return;

    try {
      setSaving((prev) => ({ ...prev, [field]: true }));
      setError(null);

      await client.service('config').patch(null, {
        credentials: {
          [field]: null,
        },
      });

      setKeyStatus((prev) => ({ ...prev, [field]: false }));
    } catch (err) {
      console.error(`Failed to clear ${field}:`, err);
      setError(err instanceof Error ? err.message : `Failed to clear ${field}`);
      throw err;
    } finally {
      setSaving((prev) => ({ ...prev, [field]: false }));
    }
  };

  // Base URL save handler
  const handleSaveBaseUrl = async () => {
    if (!client) return;

    try {
      setSaving((prev) => ({ ...prev, ANTHROPIC_BASE_URL: true }));
      setError(null);

      const value = baseUrlInput.trim();
      await client.service('config').patch(null, {
        credentials: {
          ANTHROPIC_BASE_URL: value || null,
        },
      });

      setBaseUrl(value);
    } catch (err) {
      console.error('Failed to save base URL:', err);
      setError(err instanceof Error ? err.message : 'Failed to save base URL');
      throw err;
    } finally {
      setSaving((prev) => ({ ...prev, ANTHROPIC_BASE_URL: false }));
    }
  };

  // Base URL clear handler
  const handleClearBaseUrl = async () => {
    if (!client) return;

    try {
      setSaving((prev) => ({ ...prev, ANTHROPIC_BASE_URL: true }));
      setError(null);

      await client.service('config').patch(null, {
        credentials: {
          ANTHROPIC_BASE_URL: null,
        },
      });

      setBaseUrl('');
      setBaseUrlInput('');
    } catch (err) {
      console.error('Failed to clear base URL:', err);
      setError(err instanceof Error ? err.message : 'Failed to clear base URL');
      throw err;
    } finally {
      setSaving((prev) => ({ ...prev, ANTHROPIC_BASE_URL: false }));
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
      <Alert
        message="Authentication Methods"
        description={
          <div>
            <p style={{ marginBottom: token.marginXS }}>
              There are three ways to authenticate with AI providers,{' '}
              <strong>in order of precedence</strong>:
            </p>
            <ol style={{ paddingLeft: token.paddingMD, marginBottom: 0 }}>
              <li style={{ marginBottom: token.marginXXS }}>
                <strong>Per-user API keys</strong> - Set in user profile, highest priority
              </li>
              <li style={{ marginBottom: token.marginXXS }}>
                <strong>Global keys (this UI or CLI)</strong> - Keys stored in{' '}
                <code>~/.agor/config.yaml</code> override environment variables
              </li>
              <li style={{ marginBottom: token.marginXXS }}>
                <strong>Environment variables</strong> - Set <code>ANTHROPIC_API_KEY</code>,{' '}
                <code>OPENAI_API_KEY</code>, etc. wherever you start the Agor daemon
              </li>
              <li>
                <strong>Individual CLI flows</strong> (e.g., <code>claude login</code>) - Each tool
                retains authentication in its own config
              </li>
            </ol>
          </div>
        }
        type="info"
        icon={<InfoCircleOutlined />}
        showIcon
        style={{ marginBottom: token.marginLG }}
      />

      {error && (
        <Alert
          message={error}
          type="error"
          icon={<WarningOutlined />}
          showIcon
          closable
          onClose={() => setError(null)}
          style={{ marginBottom: token.marginLG }}
        />
      )}

      <ApiKeyFields
        keyStatus={keyStatus}
        onSave={handleSave}
        onClear={handleClear}
        saving={saving}
      />

      <Divider />

      <div style={{ marginTop: token.marginLG }}>
        <Text strong style={{ display: 'block', marginBottom: token.marginXS }}>
          Anthropic API Base URL (Optional)
        </Text>
        <Text type="secondary" style={{ display: 'block', marginBottom: token.marginMD }}>
          Customize the Anthropic API endpoint for proxies, Claude Enterprise deployments, or
          third-party compatible APIs (e.g., OpenRouter, AWS Bedrock).
        </Text>

        <Space.Compact style={{ width: '100%', marginBottom: token.marginXS }}>
          <Input
            placeholder="https://api.anthropic.com (default)"
            value={baseUrlInput}
            onChange={(e) => setBaseUrlInput(e.target.value)}
            onPressEnter={handleSaveBaseUrl}
            style={{ flex: 1 }}
          />
          <Button
            type="primary"
            onClick={handleSaveBaseUrl}
            loading={saving.ANTHROPIC_BASE_URL}
            disabled={baseUrlInput === baseUrl}
          >
            Save
          </Button>
          {baseUrl && (
            <Button danger onClick={handleClearBaseUrl} loading={saving.ANTHROPIC_BASE_URL}>
              Clear
            </Button>
          )}
        </Space.Compact>

        <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          Leave empty to use the default Anthropic API endpoint. Learn more:{' '}
          <Link href="https://github.com/anthropics/claude-code/issues/216" target="_blank">
            Custom API endpoints
          </Link>
        </Text>
      </div>
    </div>
  );
};
