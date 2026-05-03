import type { AgenticToolName } from '@agor-live/client';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { Button, Input, Space, Tooltip, Typography, theme } from 'antd';
import { useState } from 'react';
import { Tag } from './Tag';

const { Text, Link } = Typography;

/**
 * One configurable credential / config field for a given agentic tool.
 * Field name is the env var name exported into the SDK CLI environment.
 */
export interface AgenticToolFieldConfig {
  /** Env var name. Matches the key under `agentic_tools[tool][field]` on disk. */
  field: string;
  /** Human-readable label shown above the input. */
  label: string;
  /** Short qualifier shown next to the label (e.g. "Pro / Max plan"). */
  description?: string;
  /** Placeholder for the input. */
  placeholder?: string;
  /** "Get your key at" link (omit for non-credential fields like base URLs). */
  docUrl?: string;
  /** Inline helper rendered under the doc link (CLI hint, fallback caveats, etc.). */
  helper?: React.ReactNode;
  /**
   * Render mode. Default 'password' (masked). Use 'text' for non-secret config
   * like ANTHROPIC_BASE_URL where the user benefits from seeing the value.
   */
  type?: 'password' | 'text';
}

/**
 * Per-tool field definitions. Field names are env var names — the executor
 * spawns the SDK with these literal env vars set. Adding a new SDK config knob
 * means: (a) declare it here, (b) declare it on `AgenticToolsConfig` in
 * packages/core/src/types/user.ts, (c) the migration is automatic.
 */
export const TOOL_FIELD_CONFIGS: Record<AgenticToolName, AgenticToolFieldConfig[]> = {
  'claude-code': [
    {
      field: 'ANTHROPIC_API_KEY',
      label: 'Anthropic API Key',
      description: '(pay-as-you-go / Console)',
      placeholder: 'sk-ant-api03-...',
      docUrl: 'https://console.anthropic.com',
    },
    {
      field: 'CLAUDE_CODE_OAUTH_TOKEN',
      label: 'Claude Subscription Token',
      description: '(Pro / Max plan)',
      placeholder: 'sk-ant-oat01-...',
      docUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
    },
    {
      field: 'ANTHROPIC_AUTH_TOKEN',
      label: 'Anthropic Auth Token',
      description: '(optional — proxy / enterprise)',
      placeholder: 'token...',
    },
    {
      field: 'ANTHROPIC_BASE_URL',
      label: 'Anthropic Base URL',
      description: '(optional — gateway / proxy)',
      placeholder: 'https://api.anthropic.com',
      type: 'text',
    },
  ],
  codex: [
    {
      field: 'OPENAI_API_KEY',
      label: 'OpenAI API Key',
      description: '(Codex)',
      placeholder: 'sk-proj-...',
      docUrl: 'https://platform.openai.com/api-keys',
    },
  ],
  gemini: [
    {
      field: 'GEMINI_API_KEY',
      label: 'Gemini API Key',
      placeholder: 'AIza...',
      docUrl: 'https://aistudio.google.com/app/apikey',
    },
  ],
  copilot: [
    {
      field: 'COPILOT_GITHUB_TOKEN',
      label: 'GitHub Token',
      description: '(Copilot)',
      placeholder: 'ghp_...',
      docUrl: 'https://github.com/settings/tokens',
    },
  ],
  opencode: [],
};

/** Map field name → presence flag (true if the user has a value stored). */
export type FieldStatus = Record<string, boolean>;

export interface ApiKeyFieldsProps {
  /**
   * Tool whose credential/config fields are being edited. Used for the
   * "Passed to the X SDK as Y" tooltip and as the default field-set lookup.
   */
  tool: AgenticToolName;
  /** Per-field set/unset flags from `user.agentic_tools[tool]`. */
  fieldStatus: FieldStatus;
  /** Persist a new value for one field (encrypts at rest). */
  onSave: (field: string, value: string) => Promise<void>;
  /** Clear the stored value for one field. */
  onClear: (field: string) => Promise<void>;
  /** Per-field saving spinner state. */
  saving?: Record<string, boolean>;
  /** Disable all inputs (e.g. while RBAC is loading). */
  disabled?: boolean;
  /**
   * Override the field set rendered for this tool. Defaults to
   * `TOOL_FIELD_CONFIGS[tool]`. Used by the global/admin config screen to
   * exclude per-user-only fields (e.g. `CLAUDE_CODE_OAUTH_TOKEN` is a
   * Pro/Max subscription token and is meaningless at global scope).
   */
  fields?: AgenticToolFieldConfig[];
}

export const ApiKeyFields: React.FC<ApiKeyFieldsProps> = ({
  tool,
  fieldStatus,
  onSave,
  onClear,
  saving = {},
  disabled = false,
  fields,
}) => {
  const { token } = theme.useToken();
  const [inputValues, setInputValues] = useState<Record<string, string>>({});

  const configs = fields ?? TOOL_FIELD_CONFIGS[tool] ?? [];

  const handleSave = async (field: string) => {
    const value = inputValues[field]?.trim();
    if (!value) return;

    await onSave(field, value);
    setInputValues((prev) => ({ ...prev, [field]: '' }));
  };

  const renderField = (config: AgenticToolFieldConfig) => {
    const { field, label, description, placeholder, docUrl, helper, type = 'password' } = config;
    const isSet = !!fieldStatus[field];
    const InputComponent = type === 'password' ? Input.Password : Input;

    return (
      <div key={field} style={{ marginBottom: token.marginLG }}>
        <Space orientation="vertical" size="small" style={{ width: '100%' }}>
          <Space wrap>
            <Text strong>{label}</Text>
            {description && <Text type="secondary">{description}</Text>}
            {/*
              Info bubble surfaces the env-var contract: the literal name that
              gets exported into the SDK CLI process. This is the connection
              between "Anthropic API Key" (UI affordance) and ANTHROPIC_API_KEY
              (what claude-code's CLI actually reads).
            */}
            <Tooltip
              title={
                <span>
                  Passed to the {tool} SDK as <code>{field}</code>
                </span>
              }
            >
              <InfoCircleOutlined style={{ color: token.colorTextSecondary, cursor: 'help' }} />
            </Tooltip>
            {isSet ? (
              <Tag icon={<CheckCircleOutlined />} color="success">
                Set
              </Tag>
            ) : (
              <Tag icon={<CloseCircleOutlined />} color="default">
                Not Set
              </Tag>
            )}
          </Space>

          {isSet ? (
            <Button
              danger
              icon={<DeleteOutlined />}
              onClick={() => onClear(field)}
              loading={saving[field]}
              disabled={disabled}
            >
              Clear
            </Button>
          ) : (
            <Space.Compact style={{ width: '100%' }}>
              <InputComponent
                placeholder={placeholder}
                value={inputValues[field] || ''}
                onChange={(e) => setInputValues((prev) => ({ ...prev, [field]: e.target.value }))}
                onPressEnter={() => handleSave(field)}
                style={{ flex: 1 }}
                disabled={disabled}
              />
              <Button
                type="primary"
                onClick={() => handleSave(field)}
                loading={saving[field]}
                disabled={disabled || !inputValues[field]?.trim()}
              >
                Save
              </Button>
            </Space.Compact>
          )}

          {docUrl && (
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              Get your key at:{' '}
              <Link href={docUrl} target="_blank">
                {docUrl}
              </Link>
            </Text>
          )}
          {helper}
          {/* Built-in per-field helpers retained from the legacy component. */}
          {field === 'CLAUDE_CODE_OAUTH_TOKEN' && !isSet && (
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              Run{' '}
              <Text code style={{ fontSize: token.fontSizeSM }}>
                claude setup-token
              </Text>{' '}
              in a terminal where the Claude CLI is installed and signed in to your Pro/Max plan,
              then paste the resulting token here.
            </Text>
          )}
          {field === 'ANTHROPIC_AUTH_TOKEN' && (
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              Alternative to the API key for token-based auth (AWS Bedrock, OAuth proxies, custom
              auth flows). Leave empty unless your gateway requires it.
            </Text>
          )}
          {field === 'ANTHROPIC_BASE_URL' && (
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              Override only when routing Claude Code through an internal gateway, proxy, or regional
              endpoint. Leave empty to use Anthropic's default API.
            </Text>
          )}
          {field === 'COPILOT_GITHUB_TOKEN' && (
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              Falls back to{' '}
              <Text code style={{ fontSize: token.fontSizeSM }}>
                GH_TOKEN
              </Text>{' '}
              /{' '}
              <Text code style={{ fontSize: token.fontSizeSM }}>
                GITHUB_TOKEN
              </Text>{' '}
              if unset. Set this explicitly to point Copilot at a different account (e.g. one with
              an active Copilot subscription) or to limit blast radius — the global git token often
              has broader scopes than Copilot needs.
            </Text>
          )}
        </Space>
      </div>
    );
  };

  if (configs.length === 0) {
    return null;
  }

  return (
    <Space orientation="vertical" size="large" style={{ width: '100%' }}>
      {configs.map((config) => renderField(config))}
    </Space>
  );
};
