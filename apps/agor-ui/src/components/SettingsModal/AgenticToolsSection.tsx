import type {
  AgenticToolConfigField,
  AgenticToolName,
  AgorClient,
  ProviderResolutionPolicy,
  TenantAgenticToolName,
  TenantAgenticToolSettings,
} from '@agor-live/client';
import { Alert, Select, Space, Spin, Switch, Tabs, Typography, theme } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { agorStore } from '../../store/agorStore';
import {
  type AgenticToolFieldConfig,
  ApiKeyFields,
  type FieldStatus,
  TOOL_FIELD_CONFIGS,
} from '../ApiKeyFields';
import { ToolIcon } from '../ToolIcon';
import { AgenticToolPresetsManager } from './AgenticToolPresetsManager';

export interface AgenticToolsSectionProps {
  client: AgorClient | null;
}

const TOOL_LABELS: Record<TenantAgenticToolName, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
  copilot: 'GitHub Copilot',
  cursor: 'Cursor SDK',
  opencode: 'OpenCode',
};

const TENANT_TOOL_FIELDS: Record<TenantAgenticToolName, AgenticToolFieldConfig[]> = {
  'claude-code': TOOL_FIELD_CONFIGS['claude-code'].filter(
    (field) => field.field !== 'CLAUDE_CODE_OAUTH_TOKEN'
  ),
  codex: TOOL_FIELD_CONFIGS.codex,
  gemini: TOOL_FIELD_CONFIGS.gemini,
  copilot: TOOL_FIELD_CONFIGS.copilot,
  cursor: TOOL_FIELD_CONFIGS.cursor,
  opencode: [],
};

const RESOLUTION_POLICIES: Array<{
  value: ProviderResolutionPolicy;
  label: string;
  description: string;
}> = [
  {
    value: 'user_required',
    label: 'Require personal',
    description: 'Use personal configuration only.',
  },
  {
    value: 'user_preferred',
    label: 'Prefer personal',
    description: 'Use personal configuration, then workspace configuration.',
  },
  {
    value: 'tenant_preferred',
    label: 'Prefer workspace',
    description: 'Use workspace configuration, then personal configuration.',
  },
  {
    value: 'tenant_required',
    label: 'Require workspace',
    description: 'Use workspace configuration only.',
  },
];

export const AgenticToolsSection: React.FC<AgenticToolsSectionProps> = ({ client }) => {
  const { token } = theme.useToken();
  const [settings, setSettings] = useState<
    Partial<Record<TenantAgenticToolName, TenantAgenticToolSettings>>
  >({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<Partial<Record<AgenticToolConfigField, boolean>>>({});

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      const result = await client.service('agentic-tool-settings').find();
      const rows = Array.isArray(result) ? result : result.data;
      setSettings(
        Object.fromEntries(rows.map((row) => [row.tool, row])) as Partial<
          Record<TenantAgenticToolName, TenantAgenticToolSettings>
        >
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load agentic tools');
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = async (
    tool: TenantAgenticToolName,
    data: {
      enabled?: boolean;
      resolution_policy?: ProviderResolutionPolicy;
      inline_configuration_allowed?: boolean;
      connection?: Partial<Record<AgenticToolConfigField, string | null>>;
    }
  ) => {
    if (!client) return;
    try {
      setError(null);
      const updated = await client.service('agentic-tool-settings').patch(tool, data);
      setSettings((current) => ({ ...current, [tool]: updated }));
      const currentStore = agorStore.getState().agenticToolSettingsByName;
      agorStore
        .getState()
        .setAgenticToolSettings(
          [...currentStore.values()].filter((item) => item.tool !== tool).concat(updated)
        );
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save agentic tool');
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
      {error && (
        <Alert
          title={error}
          type="error"
          closable
          onClose={() => setError(null)}
          style={{ marginBottom: token.marginLG }}
        />
      )}
      <Alert
        title="Workspace agentic tools"
        description="Control tool availability, choose explicit personal/workspace credential precedence, and manage workspace connections."
        type="info"
        showIcon
        style={{ marginBottom: token.marginLG }}
      />
      <Tabs
        defaultActiveKey={
          (Object.keys(TOOL_LABELS) as TenantAgenticToolName[]).find(
            (tool) => settings[tool]?.enabled !== false
          ) ?? 'claude-code'
        }
        items={(Object.keys(TOOL_LABELS) as TenantAgenticToolName[]).map((tool) => {
          const current = settings[tool] ?? {
            tool,
            enabled: true,
            resolution_policy: 'user_preferred' as const,
            inline_configuration_allowed: true,
            connection: {},
          };
          const fieldStatus: FieldStatus = Object.fromEntries(
            Object.entries(current.connection).map(([field, status]) => [field, status?.configured])
          );
          return {
            key: tool,
            label: (
              <Space size={6}>
                <ToolIcon tool={tool} size={18} />
                <span>{TOOL_LABELS[tool]}</span>
              </Space>
            ),
            children: (
              <Space direction="vertical" size="large" style={{ width: '100%' }}>
                <Space>
                  <Switch
                    checked={current.enabled}
                    onChange={(enabled) => void patch(tool, { enabled })}
                  />
                  <Typography.Text>
                    {current.enabled ? 'Available in this workspace' : 'Disabled in this workspace'}
                  </Typography.Text>
                </Space>
                <Tabs
                  defaultActiveKey="authentication"
                  items={[
                    {
                      key: 'authentication',
                      label: 'Authentication',
                      children:
                        TENANT_TOOL_FIELDS[tool].length > 0 ? (
                          <Space direction="vertical" size="large" style={{ width: '100%' }}>
                            <Space direction="vertical" size="small" style={{ width: '100%' }}>
                              <Typography.Text strong>Credential resolution</Typography.Text>
                              <Select
                                value={current.resolution_policy}
                                style={{ width: '100%', maxWidth: 420 }}
                                options={RESOLUTION_POLICIES.map((policy) => ({
                                  value: policy.value,
                                  label: policy.label,
                                  title: policy.description,
                                }))}
                                onChange={(resolution_policy) =>
                                  void patch(tool, { resolution_policy })
                                }
                              />
                              <Typography.Text type="secondary">
                                {
                                  RESOLUTION_POLICIES.find(
                                    (policy) => policy.value === current.resolution_policy
                                  )?.description
                                }
                              </Typography.Text>
                            </Space>
                            <ApiKeyFields
                              tool={tool as AgenticToolName}
                              fields={TENANT_TOOL_FIELDS[tool]}
                              fieldStatus={fieldStatus}
                              onSave={async (field, value) => {
                                setSaving((state) => ({ ...state, [field]: true }));
                                try {
                                  await patch(tool, { connection: { [field]: value } });
                                } finally {
                                  setSaving((state) => ({ ...state, [field]: false }));
                                }
                              }}
                              onClear={async (field) => {
                                setSaving((state) => ({ ...state, [field]: true }));
                                try {
                                  await patch(tool, { connection: { [field]: null } });
                                } finally {
                                  setSaving((state) => ({ ...state, [field]: false }));
                                }
                              }}
                              saving={saving}
                            />
                          </Space>
                        ) : (
                          <Alert
                            type="info"
                            showIcon
                            title="No workspace authentication settings"
                            description={`${TOOL_LABELS[tool]} does not currently expose a centrally managed connection.`}
                          />
                        ),
                    },
                    {
                      key: 'presets',
                      label: 'Presets',
                      children: (
                        <Space direction="vertical" size="large" style={{ width: '100%' }}>
                          <Space direction="vertical" size="small">
                            <Space>
                              <Switch
                                checked={current.inline_configuration_allowed}
                                onChange={(inline_configuration_allowed) =>
                                  void patch(tool, { inline_configuration_allowed })
                                }
                              />
                              <Typography.Text strong>Allow inline configuration</Typography.Text>
                            </Space>
                            <Typography.Text type="secondary">
                              {current.inline_configuration_allowed
                                ? 'Members may choose a preset or define configuration directly.'
                                : 'Members must choose an administrator-managed preset.'}
                            </Typography.Text>
                          </Space>
                          {client && (
                            <AgenticToolPresetsManager
                              client={client}
                              tool={tool}
                              onError={setError}
                            />
                          )}
                        </Space>
                      ),
                    },
                  ]}
                />
              </Space>
            ),
          };
        })}
      />
    </div>
  );
};
