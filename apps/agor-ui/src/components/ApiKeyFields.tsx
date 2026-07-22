import type {
  AgenticToolConfigField,
  AgenticToolName,
  AuthCheckResult,
  CredentialSpecKey,
} from '@agor-live/client';
import { resolveCredentialSpec, sanitizeCredential } from '@agor-live/client';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  InfoCircleOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { Button, Input, Space, Tooltip, Typography, theme } from 'antd';
import { useState } from 'react';
import { ClaudeSubscriptionTokenInstructions } from './ClaudeSubscriptionTokenInstructions';
import { CredentialFieldFeedback } from './credentials/CredentialFieldFeedback';
import { useCredentialFields } from './credentials/useCredentialField';
import { Tag } from './Tag';

/** Spec kinds that have a live `check-auth` probe worth surfacing a Verify affordance for. */
const VERIFIABLE_SPEC_KEYS = new Set<CredentialSpecKey>([
  'anthropic-api-key',
  'anthropic-oauth-token',
  'openai-api-key',
  'gemini-api-key',
  'github-token',
  'cursor-api-key',
]);

const isVerifiableField = (field: AgenticToolConfigField): boolean => {
  const spec = resolveCredentialSpec(field);
  return !!spec && VERIFIABLE_SPEC_KEYS.has(spec.key);
};

/** Live-verify (Layer 3) result line. `unknown` is a fail-safe, not a rejection. */
const VerifyResultText: React.FC<{
  verify?: { verifying: boolean; result?: AuthCheckResult };
  providerName?: string;
}> = ({ verify, providerName }) => {
  const { token } = theme.useToken();
  const result = verify?.result;
  if (!result || verify?.verifying) return null;
  const provider = providerName || 'the provider';

  if (result.status === 'authenticated') {
    return (
      <Text type="success" style={{ fontSize: token.fontSizeSM }}>
        Verified with {provider}
      </Text>
    );
  }
  if (result.status === 'unauthenticated') {
    // On a definitive rejection the user must see the provider named, so prefer
    // our provider-attributed copy over the daemon's generic rejection hint.
    return (
      <Text type="danger" style={{ fontSize: token.fontSizeSM }}>
        {`${provider} rejected this key. It may have been revoked or copied incompletely — regenerate and paste again.`}
      </Text>
    );
  }
  // 'unknown' is a failure to VERIFY (transport/timeout), not a rejection — keep
  // the daemon's specific hint here.
  return (
    <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
      {result.hint ?? `Couldn't verify with ${provider} right now — try again in a moment.`}
    </Text>
  );
};

const { Text, Link } = Typography;

/**
 * One configurable credential / config field for a given agentic tool.
 * Field name is the env var name exported into the SDK CLI environment.
 */
export interface AgenticToolFieldConfig {
  /** Env var name. Matches the key under `agentic_tools[tool][field]` on disk. */
  field: AgenticToolConfigField;
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
      docUrl: 'https://platform.claude.com/settings/keys',
      helper: (
        <Text type="secondary" style={{ fontSize: 12 }}>
          If you use a Claude subscription, use the Claude Subscription Token below instead.
        </Text>
      ),
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
      helper: (
        <Text type="secondary" style={{ fontSize: 12 }}>
          Alternative: on the machine Agor runs sessions on, run{' '}
          <Text code style={{ fontSize: 12 }}>
            codex login --device-auth
          </Text>{' '}
          to use Codex CLI account auth without storing an OpenAI key in Agor.{' '}
          <Link href="https://agor.live/guide/extended-install#authentication" target="_blank">
            Learn more →
          </Link>
        </Text>
      ),
    },
    {
      field: 'OPENAI_BASE_URL',
      label: 'OpenAI Base URL',
      description: '(optional — gateway / proxy / self-hosted)',
      placeholder: 'https://api.openai.com/v1',
      type: 'text',
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
  cursor: [
    {
      field: 'CURSOR_API_KEY',
      label: 'Cursor API Key',
      description: '(experimental SDK)',
      placeholder: 'key_...',
      docUrl: 'https://cursor.com/dashboard/integrations',
    },
  ],
  opencode: [],
  // Claude Code CLI uses the same Anthropic credentials as the SDK
  // path — surface the same fields so the Defaults panel renders
  // them under the CLI tab too. Backed by the same `user.agentic_tools`
  // sub-key, so a key set under either tab is visible from the other.
  'claude-code-cli': [
    {
      field: 'ANTHROPIC_API_KEY',
      label: 'Anthropic API Key',
      description: '(pay-as-you-go / Console)',
      placeholder: 'sk-ant-api03-...',
      docUrl: 'https://platform.claude.com/settings/keys',
      helper: (
        <Text type="secondary" style={{ fontSize: 12 }}>
          If you use a Claude subscription, use the Claude Subscription Token below instead.
        </Text>
      ),
    },
    {
      field: 'CLAUDE_CODE_OAUTH_TOKEN',
      label: 'Claude Subscription Token',
      description: '(Pro / Max plan)',
      placeholder: 'sk-ant-oat01-...',
      docUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
    },
  ],
};

/** Map field name → presence flag (true if the user has a value stored). */
export type FieldStatus = Partial<Record<AgenticToolConfigField, boolean>>;

export interface ApiKeyFieldsProps {
  /**
   * Tool whose credential/config fields are being edited. Used for the
   * "Passed to the X SDK as Y" tooltip and as the default field-set lookup.
   */
  tool: AgenticToolName;
  /** Per-field set/unset flags from `user.agentic_tools[tool]`. */
  fieldStatus: FieldStatus;
  /** Persist a new value for one field (encrypts at rest). */
  onSave: (field: AgenticToolConfigField, value: string) => Promise<void>;
  /** Clear the stored value for one field. */
  onClear: (field: AgenticToolConfigField) => Promise<void>;
  /**
   * Live-verify a credential via the daemon `check-auth` probe (Layer 3). Called
   * with the freshly-saved value right after save, and with no value when the
   * user clicks Verify on an already-stored key (the daemon resolves it). Omit to
   * hide the Verify affordance entirely.
   */
  onVerify?: (field: AgenticToolConfigField, value?: string) => Promise<AuthCheckResult>;
  /** Per-field saving spinner state. */
  saving?: Partial<Record<AgenticToolConfigField, boolean>>;
  /** Disable all inputs (e.g. while RBAC is loading). */
  disabled?: boolean;
  /**
   * Override the field set rendered for this tool. Defaults to
   * `TOOL_FIELD_CONFIGS[tool]`. Used by the global/admin config screen to
   * exclude per-user-only fields (e.g. `CLAUDE_CODE_OAUTH_TOKEN` is a
   * Pro/Max subscription token and is meaningless at global scope).
   */
  fields?: AgenticToolFieldConfig[];
  /**
   * Plaintext values for non-secret fields the requester is allowed to see
   * (server returns this only for the field's owner; see
   * `AGENTIC_TOOLS_PUBLIC_FIELDS` on the daemon side). When a value is
   * present and the field is `type: 'text'`, the saved value is rendered
   * back to the user instead of just a "Set" tag — useful for base URLs
   * where the exact path matters.
   */
  publicValues?: Partial<Record<AgenticToolConfigField, string>>;
}

interface VerifyState {
  verifying: boolean;
  result?: AuthCheckResult;
}

export const ApiKeyFields: React.FC<ApiKeyFieldsProps> = ({
  tool,
  fieldStatus,
  onSave,
  onClear,
  onVerify,
  saving = {},
  disabled = false,
  fields,
  publicValues,
}) => {
  const { token } = theme.useToken();
  const [inputValues, setInputValues] = useState<Partial<Record<AgenticToolConfigField, string>>>(
    {}
  );
  const [verifyByField, setVerifyByField] = useState<
    Partial<Record<AgenticToolConfigField, VerifyState>>
  >({});
  const credentials = useCredentialFields();

  const configs = fields ?? TOOL_FIELD_CONFIGS[tool] ?? [];

  const runVerify = async (field: AgenticToolConfigField, value?: string) => {
    if (!onVerify) return;
    setVerifyByField((prev) => ({ ...prev, [field]: { verifying: true } }));
    try {
      const result = await onVerify(field, value);
      setVerifyByField((prev) => ({ ...prev, [field]: { verifying: false, result } }));
    } catch {
      setVerifyByField((prev) => ({ ...prev, [field]: { verifying: false } }));
    }
  };

  // Paste/blur: apply the always-safe sanitize and surface the opt-in fix + lint.
  const inspectInput = (field: AgenticToolConfigField, raw: string) => {
    if (!raw) return;
    const sanitized = credentials.inspect(field, raw);
    setInputValues((prev) => ({ ...prev, [field]: sanitized }));
  };

  // "Clean it up" — the only place the opt-in fix is applied, on explicit click.
  const cleanUp = (field: AgenticToolConfigField) => {
    const fixed = credentials.applyFix(field, inputValues[field] ?? '');
    setInputValues((prev) => ({ ...prev, [field]: fixed }));
  };

  const handleSave = async (field: AgenticToolConfigField) => {
    // Save exactly what's displayed (minus always-safe edge/invisible cleanup) —
    // if the user declined the opt-in fix, we honor their value verbatim.
    const value = sanitizeCredential(inputValues[field] ?? '');
    if (!value) return;

    await onSave(field, value);
    setInputValues((prev) => ({ ...prev, [field]: '' }));
    credentials.reset(field);
    if (isVerifiableField(field)) void runVerify(field, value);
  };

  const renderField = (config: AgenticToolFieldConfig) => {
    const { field, label, description, placeholder, docUrl, helper, type = 'password' } = config;
    const isSet = !!fieldStatus[field];
    const InputComponent = type === 'password' ? Input.Password : Input;
    // Non-secret fields (`type: 'text'`, e.g. base URLs) get their saved
    // value echoed back to the owner so they can verify the exact value
    // without clearing and retyping. Secret fields never show plaintext.
    const visibleSavedValue = type === 'text' && isSet ? publicValues?.[field] : undefined;
    const feedback = credentials.get(field);
    const verify = verifyByField[field];
    const canVerify = !!onVerify && isVerifiableField(field);
    const providerName = resolveCredentialSpec(field)?.provider;

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
            <Space orientation="vertical" size="small" style={{ width: '100%' }}>
              <Space wrap size="small" style={{ width: '100%' }}>
                {visibleSavedValue && (
                  <Text
                    code
                    copyable
                    style={{ fontSize: token.fontSizeSM, wordBreak: 'break-all' }}
                  >
                    {visibleSavedValue}
                  </Text>
                )}
                {canVerify && (
                  <Button
                    icon={<SafetyCertificateOutlined />}
                    onClick={() => runVerify(field)}
                    loading={verify?.verifying}
                    disabled={disabled}
                  >
                    Verify
                  </Button>
                )}
                <Button
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => onClear(field)}
                  loading={saving[field]}
                  disabled={disabled}
                >
                  Clear
                </Button>
              </Space>
              <VerifyResultText verify={verify} providerName={providerName} />
            </Space>
          ) : (
            <>
              <Space.Compact style={{ width: '100%' }}>
                <InputComponent
                  placeholder={placeholder}
                  value={inputValues[field] || ''}
                  onChange={(e) => {
                    setInputValues((prev) => ({ ...prev, [field]: e.target.value }));
                    credentials.reset(field);
                  }}
                  onPaste={(e) => {
                    // The input's value updates after the paste event; read it
                    // from the DOM on the next tick (state is still stale here).
                    const el = e.currentTarget;
                    window.setTimeout(() => inspectInput(field, el.value), 0);
                  }}
                  onBlur={() => inspectInput(field, inputValues[field] ?? '')}
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
              <CredentialFieldFeedback
                lint={feedback.lint}
                fix={feedback.fix}
                onApplyFix={() => cleanUp(field)}
              />
            </>
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
              <ClaudeSubscriptionTokenInstructions />
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
          {field === 'OPENAI_BASE_URL' && (
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              Point Codex at any OpenAI-compatible endpoint (internal gateway, corporate proxy, or a
              localhost server like vLLM / Ollama / LM Studio). Leave empty to use OpenAI's default
              API. The OpenAI API Key above is sent as the bearer token.
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
