import type { AgorClient, TenantCorsSettings } from '@agor-live/client';
import { normalizeTenantCorsOrigin } from '@agor-live/client';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Input, List, Space, Spin, Tag, Typography, theme } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useThemedMessage } from '@/utils/message';

export interface CorsSettingsSectionProps {
  client: AgorClient | null;
}

export const CorsSettingsSection: React.FC<CorsSettingsSectionProps> = ({ client }) => {
  const { modal } = App.useApp();
  const { showSuccess, showWarning } = useThemedMessage();
  const { token } = theme.useToken();
  const [settings, setSettings] = useState<TenantCorsSettings | null>(null);
  const [origins, setOrigins] = useState<string[]>([]);
  const [newOrigin, setNewOrigin] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
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

  const dirty = useMemo(
    () =>
      Boolean(
        settings &&
          (settings.origins.length !== origins.length ||
            settings.origins.some((origin, index) => origin !== origins[index]))
      ),
    [origins, settings]
  );

  const addOrigin = () => {
    try {
      const normalized = normalizeTenantCorsOrigin(newOrigin);
      if (origins.includes(normalized)) {
        setInputError('This origin is already listed');
        return;
      }
      setOrigins((current) => [...current, normalized].sort());
      setNewOrigin('');
      setInputError(null);
    } catch (validationError) {
      setInputError(
        validationError instanceof Error ? validationError.message : 'Enter a valid origin'
      );
    }
  };

  const persist = async () => {
    if (!client || !settings) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await client.service('tenant-cors-settings').patch('current', {
        expected_revision: settings.revision,
        origins,
      });
      setSettings(updated);
      setOrigins(updated.origins);
      showSuccess('CORS origins updated');
    } catch (saveError) {
      if ((saveError as { code?: number } | null)?.code === 409) {
        await load();
        showWarning('These origins changed elsewhere. The latest settings were reloaded.');
        return;
      }
      setError(
        saveError instanceof Error ? saveError.message : 'Failed to update workspace CORS origins'
      );
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    if (!settings) return;
    const currentOrigin = typeof window !== 'undefined' ? window.location.origin : undefined;
    const removesCurrentOrigin =
      currentOrigin !== undefined &&
      settings.origins.includes(currentOrigin) &&
      !origins.includes(currentOrigin) &&
      !settings.operator_origins.includes(currentOrigin);

    if (removesCurrentOrigin) {
      modal.confirm({
        title: 'Remove the website you are using?',
        content:
          'If this site connects to the daemon across origins, it will lose browser access after the change.',
        okText: 'Remove and save',
        okButtonProps: { danger: true },
        onOk: persist,
      });
      return;
    }
    void persist();
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
          Choose which websites may make browser requests to this workspace.
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
              title="Only allow websites you trust"
              description="Allowed websites can make browser requests to this workspace. Depending on how authentication is configured, those requests may use a signed-in user's access. CORS does not replace authentication or permissions."
            />

            <Card title="Workspace origins">
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <Space.Compact style={{ width: '100%', maxWidth: 720 }}>
                  <Input
                    value={newOrigin}
                    placeholder="https://app.example.com"
                    status={inputError ? 'error' : undefined}
                    onChange={(event) => {
                      setNewOrigin(event.target.value);
                      setInputError(null);
                    }}
                    onPressEnter={addOrigin}
                  />
                  <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    onClick={addOrigin}
                    disabled={!newOrigin.trim()}
                  >
                    Add origin
                  </Button>
                </Space.Compact>
                {inputError && <Typography.Text type="danger">{inputError}</Typography.Text>}

                {origins.length === 0 ? (
                  <Typography.Text type="secondary">
                    No workspace-specific origins are allowed.
                  </Typography.Text>
                ) : (
                  <List
                    bordered
                    dataSource={origins}
                    renderItem={(origin) => (
                      <List.Item
                        actions={[
                          <Button
                            key={`remove-${origin}`}
                            type="text"
                            danger
                            icon={<DeleteOutlined />}
                            aria-label={`Remove ${origin}`}
                            onClick={() =>
                              setOrigins((current) => current.filter((item) => item !== origin))
                            }
                          />,
                        ]}
                      >
                        <Typography.Text code>{origin}</Typography.Text>
                        {typeof window !== 'undefined' && window.location.origin === origin && (
                          <Tag color="blue" style={{ marginLeft: token.marginSM }}>
                            Current site
                          </Tag>
                        )}
                      </List.Item>
                    )}
                  />
                )}

                <Space>
                  <Button type="primary" loading={saving} disabled={!dirty} onClick={save}>
                    Save changes
                  </Button>
                  <Button disabled={!dirty || saving} onClick={() => setOrigins(settings.origins)}>
                    Reset
                  </Button>
                </Space>
              </Space>
            </Card>
          </>
        ))}

      {settings && settings.operator_origins.length > 0 && (
        <Card
          title="Operator and built-in origins"
          extra={<Tag>Read only</Tag>}
          styles={{ body: { paddingTop: token.paddingSM } }}
        >
          <Typography.Paragraph type="secondary">
            These effective baseline entries apply to every workspace and are managed outside this
            page.
          </Typography.Paragraph>
          <List
            size="small"
            dataSource={settings.operator_origins}
            renderItem={(origin) => (
              <List.Item>
                <Typography.Text code>{origin}</Typography.Text>
              </List.Item>
            )}
          />
        </Card>
      )}
    </Space>
  );
};
