import type { AgorClient, TenantCorsSettings } from '@agor-live/client';
import { normalizeTenantCorsOrigin } from '@agor-live/client';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  List,
  Popconfirm,
  Space,
  Spin,
  Tag,
  Typography,
  theme,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useThemedMessage } from '@/utils/message';

export interface CorsSettingsSectionProps {
  client: AgorClient | null;
}

interface OriginFormValues {
  origin: string;
}

export const CorsSettingsSection: React.FC<CorsSettingsSectionProps> = ({ client }) => {
  const { showSuccess, showWarning } = useThemedMessage();
  const { token } = theme.useToken();
  const [originForm] = Form.useForm<OriginFormValues>();
  const [settings, setSettings] = useState<TenantCorsSettings | null>(null);
  const [origins, setOrigins] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!client) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const current = await client.service('tenant-cors-settings').get('current');
      setSettings(current);
      setOrigins(current.origins);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : 'Failed to load workspace CORS origins'
      );
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const validateOrigin = (_rule: unknown, value?: string) => {
    if (!value?.trim()) return Promise.resolve();

    try {
      const normalized = normalizeTenantCorsOrigin(value);
      if (origins.includes(normalized)) {
        return Promise.reject(new Error('This origin is already listed'));
      }
      return Promise.resolve();
    } catch (validationError) {
      return Promise.reject(
        new Error(
          validationError instanceof Error ? validationError.message : 'Enter a valid origin'
        )
      );
    }
  };

  const persist = async (nextOrigins: string[], successMessage: string): Promise<boolean> => {
    if (!client || !settings) return false;
    setSaving(true);
    setError(null);
    try {
      const updated = await client.service('tenant-cors-settings').patch('current', {
        expected_revision: settings.revision,
        origins: nextOrigins,
      });
      setSettings(updated);
      setOrigins(updated.origins);
      showSuccess(successMessage);
      return true;
    } catch (saveError) {
      if ((saveError as { code?: number } | null)?.code === 409) {
        await load();
        showWarning('These origins changed elsewhere. The latest settings were reloaded.');
        return false;
      }
      setError(
        saveError instanceof Error ? saveError.message : 'Failed to update workspace CORS origins'
      );
      return false;
    } finally {
      setSaving(false);
    }
  };

  const addOrigin = async ({ origin }: OriginFormValues) => {
    const normalized = normalizeTenantCorsOrigin(origin);
    const nextOrigins = [...origins, normalized].sort();
    if (await persist(nextOrigins, 'CORS origin added')) {
      originForm.resetFields();
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
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div>
        <Typography.Title level={3} style={{ marginTop: 0, marginBottom: token.marginXS }}>
          CORS
        </Typography.Title>
        <Typography.Text type="secondary">
          Choose which website origins may read this workspace&apos;s API responses in a browser.
        </Typography.Text>
      </div>

      {error && (
        <Alert title={error} type="error" closable onClose={() => setError(null)} showIcon />
      )}

      {settings &&
        (!settings.enabled ? (
          <Alert
            title="Workspace CORS management is disabled"
            description="An operator disabled tenant-managed origins or selected a CORS mode that cannot preserve workspace isolation."
            type="info"
            showIcon
          />
        ) : !settings.routing_ready ? (
          <Alert
            title="Tenant routing is not ready"
            description="The daemon must be able to identify this workspace before browser authentication, including on preflight requests."
            type="error"
            showIcon
          />
        ) : (
          <>
            <Alert
              type="warning"
              showIcon
              title="Only add origins for websites you trust"
              description="Browser code loaded from an allowed origin can read this workspace's API responses. For preflighted requests, the browser checks permission before sending the request. Depending on authentication, requests may act with a signed-in user's access. CORS does not replace authentication or permissions."
            />

            <Card title="Allowed website origins">
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <Typography.Text type="secondary">
                  Only additional origins managed for this workspace are shown here. The application
                  itself and deployment-level policy are handled separately.
                </Typography.Text>
                <Form
                  form={originForm}
                  layout="vertical"
                  onFinish={addOrigin}
                  style={{ width: '100%', maxWidth: 720 }}
                >
                  <Form.Item
                    name="origin"
                    validateFirst
                    validateDebounce={300}
                    validateTrigger={['onChange', 'onBlur']}
                    extra="Enter an exact origin including http:// or https://. Paths and wildcards are not supported."
                    rules={[
                      { required: true, whitespace: true, message: 'Origin is required' },
                      { validator: validateOrigin },
                    ]}
                    style={{ marginBottom: 0 }}
                  >
                    <Input.Search
                      placeholder="https://app.example.com"
                      disabled={saving}
                      loading={saving}
                      enterButton={
                        <>
                          <PlusOutlined /> Add origin
                        </>
                      }
                      onSearch={() => originForm.submit()}
                    />
                  </Form.Item>
                </Form>

                {origins.length === 0 ? (
                  <Typography.Text type="secondary">
                    No additional workspace origins are configured.
                  </Typography.Text>
                ) : (
                  <List
                    bordered
                    dataSource={origins}
                    renderItem={(origin) => {
                      const isCurrentSite =
                        typeof window !== 'undefined' && window.location.origin === origin;
                      return (
                        <List.Item
                          actions={[
                            <Popconfirm
                              key={`remove-${origin}`}
                              title={
                                isCurrentSite
                                  ? 'Remove the origin you are using?'
                                  : 'Remove this origin?'
                              }
                              description={
                                isCurrentSite
                                  ? 'If this site relies on this workspace-managed entry, it may lose browser access after removal.'
                                  : "Browsers will no longer allow this origin to read this workspace's API responses through this entry."
                              }
                              okText="Remove"
                              cancelText="Cancel"
                              okButtonProps={{ danger: true }}
                              disabled={saving}
                              onConfirm={() =>
                                persist(
                                  origins.filter((item) => item !== origin),
                                  'CORS origin removed'
                                )
                              }
                            >
                              <Button
                                type="text"
                                danger
                                disabled={saving}
                                icon={<DeleteOutlined />}
                                aria-label={`Remove ${origin}`}
                              />
                            </Popconfirm>,
                          ]}
                        >
                          <Typography.Text code>{origin}</Typography.Text>
                          {isCurrentSite && (
                            <Tag color="blue" style={{ marginLeft: token.marginSM }}>
                              Current site
                            </Tag>
                          )}
                        </List.Item>
                      );
                    }}
                  />
                )}
              </Space>
            </Card>
          </>
        ))}
    </Space>
  );
};
