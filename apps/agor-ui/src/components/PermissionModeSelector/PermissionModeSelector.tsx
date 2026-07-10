import type { CodexApprovalPolicy, CodexSandboxMode, PermissionMode } from '@agor-live/client';
import { getDefaultPermissionMode, mapToCodexPermissionConfig } from '@agor-live/client';
import {
  EditOutlined,
  ExperimentOutlined,
  LockOutlined,
  SafetyOutlined,
  UnlockOutlined,
} from '@ant-design/icons';
import type { GlobalToken } from 'antd';
import { Radio, Select, Space, Tooltip, Typography, theme } from 'antd';

interface ModeOption {
  mode: PermissionMode;
  label: string;
  description: string;
  icon: React.ReactNode;
  tone: 'danger' | 'success' | 'info' | 'warning';
}

export interface PermissionModeSelectorProps {
  value?: PermissionMode;
  onChange?: (value: PermissionMode) => void;
  agentic_tool?:
    | 'claude-code'
    | 'claude-code-cli'
    | 'codex'
    | 'gemini'
    | 'opencode'
    | 'copilot'
    | 'cursor';
  /** If true, renders as a compact Select dropdown instead of Radio buttons */
  compact?: boolean;
  /**
   * When in Select (compact) mode, render only the icon in the trigger.
   * Defaults to `false` — trigger shows icon + label so users in roomy
   * contexts (e.g. session settings dropdown) can read the mode name.
   * Set `true` for tight surfaces like the conversation footer where
   * only the icon fits. The tooltip preserves the label either way.
   */
  iconOnly?: boolean;
  /** Render compact selects with plain text labels (useful in popovers/forms). */
  plain?: boolean;
  fullWidth?: boolean;
  /** Size for compact mode */
  size?: 'small' | 'middle' | 'large';
  /** Codex-specific: sandbox mode value */
  codexSandboxMode?: CodexSandboxMode;
  /** Codex-specific: approval policy value */
  codexApprovalPolicy?: CodexApprovalPolicy;
  /** Codex-specific: callback for dual permission changes */
  onCodexChange?: (sandbox: CodexSandboxMode, approval: CodexApprovalPolicy) => void;
}

// Claude Code permission modes (Claude Agent SDK)
const CLAUDE_CODE_MODES: ModeOption[] = [
  {
    mode: 'default',
    label: 'default',
    description: 'Prompt for each tool use (most restrictive)',
    icon: <LockOutlined />,
    tone: 'danger',
  },
  {
    mode: 'acceptEdits',
    label: 'acceptEdits',
    description: 'Auto-accept file edits, ask for other tools (recommended)',
    icon: <EditOutlined />,
    tone: 'success',
  },
  {
    mode: 'auto',
    label: 'auto',
    description: 'Model classifier approves/denies prompts, asks only when unsure',
    icon: <SafetyOutlined />,
    tone: 'info',
  },
  {
    mode: 'bypassPermissions',
    label: 'bypassPermissions',
    description: 'Allow all operations without prompting',
    icon: <UnlockOutlined />,
    tone: 'warning',
  },
  {
    mode: 'plan',
    label: 'plan',
    description: 'Generate plan without executing',
    icon: <ExperimentOutlined />,
    tone: 'info',
  },
];

// Codex permission modes (OpenAI Codex SDK)
const CODEX_MODES: ModeOption[] = [
  {
    mode: 'ask',
    label: 'untrusted',
    description: 'Only run trusted commands (ls, cat, sed) without approval',
    icon: <LockOutlined />,
    tone: 'danger',
  },
  {
    mode: 'auto',
    label: 'on-request',
    description: 'Model decides when to ask for approval',
    icon: <SafetyOutlined />,
    tone: 'success',
  },
  {
    mode: 'on-failure',
    label: 'on-failure',
    description: 'Run all commands, ask only when they fail',
    icon: <EditOutlined />,
    tone: 'warning',
  },
  {
    mode: 'allow-all',
    label: 'never',
    description: 'Never ask for approval, failures returned to model',
    icon: <UnlockOutlined />,
    tone: 'warning',
  },
];

// Gemini permission modes (Google Gemini SDK - native ApprovalMode values)
const GEMINI_MODES: ModeOption[] = [
  {
    mode: 'default',
    label: 'default',
    description: 'Prompt for each tool use (most restrictive)',
    icon: <LockOutlined />,
    tone: 'danger',
  },
  {
    mode: 'autoEdit',
    label: 'autoEdit',
    description: 'Auto-approve file edits, ask for shell/web tools',
    icon: <EditOutlined />,
    tone: 'success',
  },
  {
    mode: 'yolo',
    label: 'yolo',
    description: 'Allow all operations without prompting',
    icon: <UnlockOutlined />,
    tone: 'warning',
  },
];

// Copilot autonomous permission modes.
const COPILOT_MODES: ModeOption[] = [
  {
    mode: 'default',
    label: 'default',
    description: 'Proxy all permission requests to Agor UI for approval',
    icon: <LockOutlined />,
    tone: 'danger',
  },
  {
    mode: 'acceptEdits',
    label: 'acceptEdits',
    description: 'Auto-approve read/write operations, ask for shell/MCP (recommended)',
    icon: <EditOutlined />,
    tone: 'success',
  },
  {
    mode: 'bypassPermissions',
    label: 'bypassPermissions',
    description: 'Auto-approve all operations without prompting',
    icon: <UnlockOutlined />,
    tone: 'warning',
  },
];

// Cursor SDK is currently autonomous in Agor: @cursor/sdk does not expose a
// blocking permission callback that we can proxy to the Agor UI. Keep the UI
// honest by showing only the effective mode instead of borrowed Copilot modes.
const CURSOR_MODES: ModeOption[] = [
  {
    mode: 'bypassPermissions',
    label: 'Autonomous',
    description: 'Cursor SDK runs autonomously; Agor cannot intercept permission requests yet',
    icon: <UnlockOutlined />,
    tone: 'warning',
  },
];

// OpenCode permission modes (uses Gemini-like modes since OpenCode auto-approves)
const OPENCODE_MODES: ModeOption[] = [
  {
    mode: 'default',
    label: 'default',
    description: 'Prompt for approval before each operation',
    icon: <LockOutlined />,
    tone: 'danger',
  },
  {
    mode: 'autoEdit',
    label: 'autoEdit',
    description: 'Auto-approve all operations (recommended)',
    icon: <EditOutlined />,
    tone: 'success',
  },
  {
    mode: 'yolo',
    label: 'yolo',
    description: 'Fully bypass all permission checks',
    icon: <UnlockOutlined />,
    tone: 'warning',
  },
];

// Codex sandbox mode options
export const CODEX_SANDBOX_MODES = [
  {
    value: 'read-only',
    label: 'read-only',
    description: 'No filesystem writes',
  },
  {
    value: 'workspace-write',
    label: 'workspace-write',
    description: 'Workspace files only (blocks .git/)',
  },
  {
    value: 'danger-full-access',
    label: 'full-access',
    description: 'Full filesystem (including .git/)',
  },
];

// Codex approval policy options
export const CODEX_APPROVAL_POLICIES = [
  {
    value: 'untrusted',
    label: 'untrusted',
    description: 'Ask for every operation',
  },
  {
    value: 'on-request',
    label: 'on-request',
    description: 'Model decides when to ask',
  },
  {
    value: 'on-failure',
    label: 'on-failure',
    description: 'Ask only on failures',
  },
  {
    value: 'never',
    label: 'never',
    description: 'Auto-approve everything',
  },
];

/** Get the mode options for a given agentic tool */
const getModesForTool = (tool: PermissionModeSelectorProps['agentic_tool']): ModeOption[] => {
  switch (tool) {
    case 'codex':
      return CODEX_MODES;
    case 'gemini':
      return GEMINI_MODES;
    case 'opencode':
      return OPENCODE_MODES;
    case 'copilot':
      return COPILOT_MODES;
    case 'cursor':
      return CURSOR_MODES;
    default:
      return CLAUDE_CODE_MODES;
  }
};

const getModeColor = (tone: ModeOption['tone'], token: GlobalToken): string => {
  switch (tone) {
    case 'danger':
      return token.colorError;
    case 'success':
      return token.colorSuccess;
    case 'info':
      return token.colorInfo;
    case 'warning':
      return token.colorWarning;
  }
};

export const PermissionModeSelector: React.FC<PermissionModeSelectorProps> = ({
  value,
  onChange,
  agentic_tool = 'claude-code',
  compact = false,
  iconOnly = false,
  plain = false,
  fullWidth = false,
  size = 'middle',
  codexSandboxMode,
  codexApprovalPolicy,
  onCodexChange,
}) => {
  const { token } = theme.useToken();
  const modes = getModesForTool(agentic_tool);
  const effectiveValue =
    agentic_tool === 'cursor'
      ? 'bypassPermissions'
      : value || getDefaultPermissionMode(agentic_tool);
  // Fill Codex prop defaults from the resolved mode so the dropdown shows
  // the same values the executor will actually run with for a session
  // missing explicit sub-config.
  const codexDefaults = mapToCodexPermissionConfig(effectiveValue);
  const effectiveCodexSandboxMode = codexSandboxMode ?? codexDefaults.sandboxMode;
  const effectiveCodexApprovalPolicy = codexApprovalPolicy ?? codexDefaults.approvalPolicy;

  // Compact mode: render as Select dropdown(s)
  if (compact) {
    // Codex with onCodexChange: render sandbox + approval dropdowns
    // (used by SessionPanel for inline Codex controls)
    if (agentic_tool === 'codex' && onCodexChange) {
      return (
        <Space size={4} direction={fullWidth ? 'vertical' : 'horizontal'} style={{ width: '100%' }}>
          <Select
            value={effectiveCodexSandboxMode}
            onChange={(val) => onCodexChange(val, effectiveCodexApprovalPolicy)}
            size={size}
            placeholder="Sandbox"
            popupMatchSelectWidth={false}
            style={{
              minWidth: 70,
              width: fullWidth ? '100%' : undefined,
              fontSize: token.fontSizeSM,
            }}
            optionLabelProp="label"
            options={CODEX_SANDBOX_MODES.map(({ value, label, description }) => ({
              label,
              value,
              title: description,
            }))}
            optionRender={(option) => (
              <div style={{ lineHeight: 1.3 }}>
                <div>{option.label}</div>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {option.data.title}
                </Typography.Text>
              </div>
            )}
          />
          <Select
            value={effectiveCodexApprovalPolicy}
            onChange={(val) => onCodexChange(effectiveCodexSandboxMode, val)}
            size={size}
            placeholder="Approval"
            popupMatchSelectWidth={false}
            style={{
              minWidth: 70,
              width: fullWidth ? '100%' : undefined,
              fontSize: token.fontSizeSM,
            }}
            optionLabelProp="label"
            options={CODEX_APPROVAL_POLICIES.map(({ value, label, description }) => ({
              label,
              value,
              title: description,
            }))}
            optionRender={(option) => (
              <div style={{ lineHeight: 1.3 }}>
                <div>{option.label}</div>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {option.data.title}
                </Typography.Text>
              </div>
            )}
          />
        </Space>
      );
    }

    // All other cases: single permission mode dropdown
    // Collapsed state: icon-only with color. Dropdown: icon + label + description.
    const currentMode = modes.find((m) => m.mode === effectiveValue);
    return (
      <Tooltip
        title={
          currentMode ? `${currentMode.label} — ${currentMode.description}` : 'Permission mode'
        }
      >
        <Select
          value={effectiveValue}
          onChange={onChange}
          style={{ fontSize: token.fontSizeSM, width: fullWidth ? '100%' : undefined }}
          size={size}
          popupMatchSelectWidth={false}
          optionLabelProp="label"
          options={modes.map(({ mode, label, description, icon, tone }) => {
            const color = getModeColor(tone, token);
            return {
              label: plain ? (
                label
              ) : iconOnly ? (
                <span style={{ color, fontSize: token.fontSizeSM }}>{icon}</span>
              ) : (
                <Space size={token.marginXXS} style={{ fontSize: token.fontSizeSM }}>
                  <span style={{ color }}>{icon}</span>
                  <span>{label}</span>
                </Space>
              ),
              value: mode,
              title: description,
              icon,
              color,
            };
          })}
          optionRender={(option) => {
            const modeData = modes.find((m) => m.mode === option.value);
            return (
              <Space size={6} align="start">
                {modeData && (
                  <span style={{ color: getModeColor(modeData.tone, token) }}>{modeData.icon}</span>
                )}
                <div style={{ lineHeight: 1.3 }}>
                  <div>{modeData?.label}</div>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {modeData?.description}
                  </Typography.Text>
                </div>
              </Space>
            );
          }}
        />
      </Tooltip>
    );
  }

  // Full mode: render as Radio group with descriptions
  return (
    <Radio.Group value={effectiveValue} onChange={(e) => onChange?.(e.target.value)}>
      <Space orientation="vertical" style={{ width: '100%' }}>
        {modes.map(({ mode, label, description, icon, tone }) => (
          <Radio key={mode} value={mode}>
            <Space>
              <span style={{ color: getModeColor(tone, token) }}>{icon}</span>
              <div>
                <Typography.Text strong>{label}</Typography.Text>
                <br />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {description}
                </Typography.Text>
              </div>
            </Space>
          </Radio>
        ))}
      </Space>
    </Radio.Group>
  );
};
