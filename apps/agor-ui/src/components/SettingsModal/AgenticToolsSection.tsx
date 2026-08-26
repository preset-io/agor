import type {
  AgenticToolConfigField,
  AgenticToolName,
  AgorClient,
  ProviderResolutionPolicy,
  TenantAgenticToolName,
  TenantAgenticToolSettings,
} from '@agor-live/client';
import { Alert, Select, Space, Spin, Switch, Tabs, Typography, theme } from 'antd';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { useAuthorityOperationGuard } from '../../hooks/useAuthorityOperationGuard';
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
  identityKey: string | null;
  operationScope: readonly unknown[] | null;
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

export const AgenticToolsSection: React.FC<AgenticToolsSectionProps> = ({
  client,
  identityKey,
  operationScope,
}) => {
  const { token } = theme.useToken();
  const [settings, setSettings] = useState<
    Partial<Record<TenantAgenticToolName, TenantAgenticToolSettings>>
  >({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<Partial<Record<AgenticToolConfigField, boolean>>>({});
  const operationGuard = useAuthorityOperationGuard(operationScope);

  // biome-ignore lint/correctness/useExhaustiveDependencies: authorityKey intentionally erases caller-private state
  useLayoutEffect(() => {
    setSettings({});
    setError(null);
    setSaving({});
  }, [identityKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: operationScope intentionally releases stale generation-owned UI locks
  useLayoutEffect(() => {
    setLoading(false);
    setSaving({});
  }, [operationScope]);

  const load = useCallback(async () => {
    const operation = operationGuard.begin();
    if (!client || !operation.isCurrent()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await client.service('agentic-tool-settings').find();
      if (!operation.isCurrent()) return;
      const rows = Array.isArray(result) ? result : result.data;
      setSettings(
        Object.fromEntries(rows.map((row) => [row.tool, row])) as Partial<
          Record<TenantAgenticToolName, TenantAgenticToolSettings>
        >
      );
    } catch (loadError) {
      if (!operation.isCurrent()) return;
      setError(loadError instanceof Error ? loadError.message : 'Failed to load agentic tools');
    } finally {
      if (operation.isCurrent()) setLoading(false);
    }
  }, [client, operationGuard]);

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
    const operation = operationGuard.begin();
    if (!client || !operation.isCurrent()) return;
    try {
      setError(null);
      const updated = await client.service('agentic-tool-settings').patch(tool, data);
      if (!operation.isCurrent()) return;
      setSettings((current) => ({ ...current, [tool]: updated }));
      // Single-row admin edit: merge without touching the hydration gate.
      agorStore.getState().upsertAgenticToolSetting(updated);
    } catch (saveError) {
      if (!operation.isCurrent()) return;
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
            deployment_available: true,
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
                    disabled={!current.deployment_available}
                    onChange={(enabled) => void patch(tool, { enabled })}
                  />
                  <Typography.Text>
                    {!current.deployment_available
                      ? 'Not installed by this deployment'
                      : current.enabled
                        ? 'Installed and available in this workspace'
                        : 'Installed, but disabled in this workspace'}
                  </Typography.Text>
                </Space>
                {!current.deployment_available && (
                  <Alert
                    type="warning"
                    showIcon
                    title="This deployment did not install this agentic tool"
                    description={
                      <>
                        Workspace settings cannot install deployment packages. A deployment operator
                        must add the tool to <code>agentic_tools.installed</code> in{' '}
                        <code>config.yaml</code>, run <code>agor install --sync</code>, and restart
                        the daemon.
                      </>
                    }
                  />
                )}
                {current.deployment_available && (
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
                                identityKey={identityKey}
                                operationScope={operationScope}
                                tool={tool as AgenticToolName}
                                fields={TENANT_TOOL_FIELDS[tool]}
                                fieldStatus={fieldStatus}
                                onSave={async (field, value) => {
                                  const operation = operationGuard.begin();
                                  if (!operation.isCurrent()) return;
                                  setSaving((state) => ({ ...state, [field]: true }));
                                  try {
                                    await patch(tool, { connection: { [field]: value } });
                                  } finally {
                                    if (operation.isCurrent()) {
                                      setSaving((state) => ({ ...state, [field]: false }));
                                    }
                                  }
                                }}
                                onClear={async (field) => {
                                  const operation = operationGuard.begin();
                                  if (!operation.isCurrent()) return;
                                  setSaving((state) => ({ ...state, [field]: true }));
                                  try {
                                    await patch(tool, { connection: { [field]: null } });
                                  } finally {
                                    if (operation.isCurrent()) {
                                      setSaving((state) => ({ ...state, [field]: false }));
                                    }
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
                                identityKey={identityKey}
                                operationScope={operationScope}
                              />
                            )}
                          </Space>
                        ),
                      },
                    ]}
                  />
                )}
              </Space>
            ),
          };
        })}
      />
    </div>
  );
};
