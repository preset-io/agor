import type {
  AgenticToolConfigField,
  AgenticToolName,
  AgorClient,
  ProviderResolutionPolicy,
  TenantAgenticToolName,
  TenantAgenticToolSettings,
} from '@agor-live/client';
import {
  Alert,
  Badge,
  ConfigProvider,
  Flex,
  Menu,
  Select,
  Space,
  Spin,
  Switch,
  Tabs,
  Typography,
  theme,
} from 'antd';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
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

// Visually-hidden text so a tool's availability is never conveyed by dot color
// alone: assistive tech reads the label while sighted users see the dot.
const SR_ONLY_STYLE: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

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
  // Tool selection moved out of a stacked outer <Tabs> into a secondary sidebar
  // Menu (mirrors User Settings' AI Providers rail); the inner Authentication /
  // Presets split is now the only <Tabs> in this panel. `subTab` is kept
  // controlled so it persists as you switch tools.
  const [selectedTool, setSelectedTool] = useState<TenantAgenticToolName | null>(null);
  const [subTab, setSubTab] = useState<'authentication' | 'presets'>('authentication');

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
      // Single-row admin edit: merge without touching the hydration gate.
      agorStore.getState().upsertAgenticToolSetting(updated);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save agentic tool');
    }
  };

  const toolNames = Object.keys(TOOL_LABELS) as TenantAgenticToolName[];
  const firstEnabledTool = toolNames.find((tool) => settings[tool]?.enabled !== false);
  // Follow first-enabled until the admin explicitly picks a tool, then stick.
  const activeTool = selectedTool ?? firstEnabledTool ?? 'claude-code';

  // Secondary rail: muted selected pill so it reads as sub-navigation inside the
  // Settings content pane rather than a second main nav rail.
  const railTheme = useMemo(
    () => ({
      components: {
        Menu: {
          itemSelectedBg: token.colorFillTertiary,
          itemSelectedColor: token.colorText,
        },
      },
    }),
    [token.colorFillTertiary, token.colorText]
  );

  const toolMenuItems = toolNames.map((tool) => {
    const enabled = settings[tool]?.enabled !== false;
    return {
      key: tool,
      icon: <ToolIcon tool={tool} size={18} />,
      label: (
        <Space size={8}>
          <Badge color={enabled ? token.colorSuccess : token.colorTextQuaternary} />
          <span>{TOOL_LABELS[tool]}</span>
          <span style={SR_ONLY_STYLE}>{enabled ? 'Available' : 'Disabled'}</span>
        </Space>
      ),
    };
  });

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: token.paddingLG }}>
        <Spin size="large" />
      </div>
    );
  }

  const current = settings[activeTool] ?? {
    tool: activeTool,
    enabled: true,
    resolution_policy: 'user_preferred' as const,
    inline_configuration_allowed: true,
    connection: {},
  };
  const fieldStatus: FieldStatus = Object.fromEntries(
    Object.entries(current.connection).map(([field, status]) => [field, status?.configured])
  );

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
      <Flex gap={token.marginLG} align="stretch">
        <ConfigProvider theme={railTheme}>
          <Menu
            mode="inline"
            selectedKeys={[activeTool]}
            onClick={({ key }) => setSelectedTool(key as TenantAgenticToolName)}
            items={toolMenuItems}
            style={{
              width: 200,
              flex: '0 0 200px',
              background: 'transparent',
              borderInlineEnd: `1px solid ${token.colorBorderSecondary}`,
            }}
          />
        </ConfigProvider>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <Space size={8} align="center">
              <ToolIcon tool={activeTool} size={20} />
              <Typography.Title level={5} style={{ margin: 0 }}>
                {TOOL_LABELS[activeTool]}
              </Typography.Title>
            </Space>
            <Space>
              <Switch
                checked={current.enabled}
                onChange={(enabled) => void patch(activeTool, { enabled })}
              />
              <Typography.Text>
                {current.enabled ? 'Available in this workspace' : 'Disabled in this workspace'}
              </Typography.Text>
            </Space>
            <Tabs
              activeKey={subTab}
              onChange={(key) => setSubTab(key as 'authentication' | 'presets')}
              items={[
                {
                  key: 'authentication',
                  label: 'Authentication',
                  children:
                    TENANT_TOOL_FIELDS[activeTool].length > 0 ? (
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
                              void patch(activeTool, { resolution_policy })
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
                          tool={activeTool as AgenticToolName}
                          fields={TENANT_TOOL_FIELDS[activeTool]}
                          fieldStatus={fieldStatus}
                          onSave={async (field, value) => {
                            setSaving((state) => ({ ...state, [field]: true }));
                            try {
                              await patch(activeTool, { connection: { [field]: value } });
                            } finally {
                              setSaving((state) => ({ ...state, [field]: false }));
                            }
                          }}
                          onClear={async (field) => {
                            setSaving((state) => ({ ...state, [field]: true }));
                            try {
                              await patch(activeTool, { connection: { [field]: null } });
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
                        description={`${TOOL_LABELS[activeTool]} does not currently expose a centrally managed connection.`}
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
                              void patch(activeTool, { inline_configuration_allowed })
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
                          tool={activeTool}
                          onError={setError}
                        />
                      )}
                    </Space>
                  ),
                },
              ]}
            />
          </Space>
        </div>
      </Flex>
    </div>
  );
};
