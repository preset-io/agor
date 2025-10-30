import type { AgorClient } from '@agor/core/api';
import type { AgorConfig } from '@agor/core/config';
import { CheckCircleOutlined, InfoCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { Alert, Button, Form, Input, Space, Spin, Typography, theme } from 'antd';
import { useEffect, useState } from 'react';

const { Text, Link } = Typography;

export interface AgenticToolsTabProps {
  client: AgorClient | null;
}

interface FormValues {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
}

export const AgenticToolsTab: React.FC<AgenticToolsTabProps> = ({ client }) => {
  const { token } = theme.useToken();
  const [form] = Form.useForm<FormValues>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [_originalValues, setOriginalValues] = useState<FormValues>({});

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

        // Set form values (masked values from server)
        const values = {
          ANTHROPIC_API_KEY: config?.ANTHROPIC_API_KEY || '',
          OPENAI_API_KEY: config?.OPENAI_API_KEY || '',
          GEMINI_API_KEY: config?.GEMINI_API_KEY || '',
        };

        form.setFieldsValue(values);
        setOriginalValues(values);
      } catch (err) {
        console.error('Failed to load config:', err);
        setError(err instanceof Error ? err.message : 'Failed to load configuration');
      } finally {
        setLoading(false);
      }
    };

    loadConfig();
  }, [client, form]);

  // Explicit save handler
  const handleSave = async (field: keyof FormValues) => {
    if (!client) return;

    const value = form.getFieldValue(field);

    try {
      setSaving(prev => ({ ...prev, [field]: true }));
      setError(null);

      // Update config via PATCH (allow empty string to clear the key)
      await client.service('config').patch(null, {
        credentials: {
          [field]: value?.trim() || undefined,
        },
      });

      // Update original values to mark as saved
      setOriginalValues(prev => ({ ...prev, [field]: value }));

      // Show success indicator
      setSaved(prev => ({ ...prev, [field]: true }));

      // Clear success indicator after 2 seconds
      setTimeout(() => {
        setSaved(prev => ({ ...prev, [field]: false }));
      }, 2000);
    } catch (err) {
      console.error(`Failed to save ${field}:`, err);
      setError(err instanceof Error ? err.message : `Failed to save ${field}`);
    } finally {
      setSaving(prev => ({ ...prev, [field]: false }));
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
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Alert
          message="Keys are stored securely in your local config file (~/.agor/config.yaml)."
          type="info"
          icon={<InfoCircleOutlined />}
          showIcon
        />

        {error && (
          <Alert
            message={error}
            type="error"
            icon={<WarningOutlined />}
            showIcon
            closable
            onClose={() => setError(null)}
          />
        )}

        <Form form={form} layout="vertical" size="large">
          {/* Anthropic API Key */}
          <Form.Item
            label={
              <Space>
                <Text strong>Anthropic API Key</Text>
                <Text type="secondary">(Claude Code / Agent SDK)</Text>
              </Space>
            }
            name="ANTHROPIC_API_KEY"
          >
            <Space.Compact style={{ width: '100%' }}>
              <Input.Password placeholder="sk-ant-api03-..." style={{ flex: 1 }} />
              <Button
                type="primary"
                onClick={() => handleSave('ANTHROPIC_API_KEY')}
                loading={saving.ANTHROPIC_API_KEY}
                icon={saved.ANTHROPIC_API_KEY ? <CheckCircleOutlined /> : null}
              >
                {saved.ANTHROPIC_API_KEY ? 'Saved' : 'Save'}
              </Button>
            </Space.Compact>
          </Form.Item>
          <div style={{ marginTop: -token.marginMD, marginBottom: token.marginLG }}>
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              Get your key at:{' '}
              <Link href="https://console.anthropic.com" target="_blank">
                https://console.anthropic.com
              </Link>
            </Text>
          </div>

          {/* OpenAI API Key */}
          <Form.Item
            label={
              <Space>
                <Text strong>OpenAI API Key</Text>
                <Text type="secondary">(Codex)</Text>
              </Space>
            }
            name="OPENAI_API_KEY"
          >
            <Space.Compact style={{ width: '100%' }}>
              <Input.Password placeholder="sk-proj-..." style={{ flex: 1 }} />
              <Button
                type="primary"
                onClick={() => handleSave('OPENAI_API_KEY')}
                loading={saving.OPENAI_API_KEY}
                icon={saved.OPENAI_API_KEY ? <CheckCircleOutlined /> : null}
              >
                {saved.OPENAI_API_KEY ? 'Saved' : 'Save'}
              </Button>
            </Space.Compact>
          </Form.Item>
          <div style={{ marginTop: -token.marginMD, marginBottom: token.marginLG }}>
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              Get your key at:{' '}
              <Link href="https://platform.openai.com/api-keys" target="_blank">
                https://platform.openai.com/api-keys
              </Link>
            </Text>
          </div>

          {/* Gemini API Key */}
          <Form.Item label={<Text strong>Gemini API Key</Text>} name="GEMINI_API_KEY">
            <Space.Compact style={{ width: '100%' }}>
              <Input.Password placeholder="AIza..." style={{ flex: 1 }} />
              <Button
                type="primary"
                onClick={() => handleSave('GEMINI_API_KEY')}
                loading={saving.GEMINI_API_KEY}
                icon={saved.GEMINI_API_KEY ? <CheckCircleOutlined /> : null}
              >
                {saved.GEMINI_API_KEY ? 'Saved' : 'Save'}
              </Button>
            </Space.Compact>
          </Form.Item>
          <div style={{ marginTop: -token.marginMD, marginBottom: token.marginLG }}>
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              Get your key at:{' '}
              <Link href="https://aistudio.google.com/app/apikey" target="_blank">
                https://aistudio.google.com/app/apikey
              </Link>
            </Text>
          </div>
        </Form>
      </Space>
    </div>
  );
};
