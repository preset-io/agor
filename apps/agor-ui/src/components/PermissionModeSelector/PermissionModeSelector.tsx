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
import { Flex, Select, Space, Tooltip, Typography, theme } from 'antd';

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

// Each list is ordered most-oversight → least; the fully-autonomous "bypass"
// mode is always last and rendered in the warning tone. `label` is the human
// name shown to users; `mode` is the raw config value surfaced as muted text.
// Descriptions use the two-part formula: "what runs without asking · best for".

// Claude Code permission modes (Claude Agent SDK)
const CLAUDE_CODE_MODES: ModeOption[] = [
  {
    mode: 'default',
    label: 'Manual',
    description: 'Asks before every tool use · for high-stakes changes',
    icon: <LockOutlined />,
    tone: 'danger',
  },
  {
    mode: 'plan',
    label: 'Plan',
    description: 'Explores and plans, runs nothing · for scoping work first',
    icon: <ExperimentOutlined />,
    tone: 'info',
  },
  {
    mode: 'acceptEdits',
    label: 'Accept edits',
    description: 'Auto-approves file edits · for code you review in the diff',
    icon: <EditOutlined />,
    tone: 'success',
  },
  {
    mode: 'auto',
    label: 'Auto',
    description: 'Approves routine steps, asks when unsure · for trusted work',
    icon: <SafetyOutlined />,
    tone: 'info',
  },
  {
    mode: 'bypassPermissions',
    label: 'Bypass permissions',
    description: 'Runs everything without asking · isolated environments only',
    icon: <UnlockOutlined />,
    tone: 'warning',
  },
];

// Codex permission modes (OpenAI Codex SDK)
const CODEX_MODES: ModeOption[] = [
  {
    mode: 'ask',
    label: 'Untrusted',
    description: 'Only runs trusted read commands · for maximum caution',
    icon: <LockOutlined />,
    tone: 'danger',
  },
  {
    mode: 'auto',
    label: 'On request',
    description: 'Asks before risky commands · for trusted everyday work',
    icon: <SafetyOutlined />,
    tone: 'success',
  },
  {
    mode: 'on-failure',
    label: 'On failure',
    description: 'Runs commands, asks only when they fail · for fast iteration',
    icon: <EditOutlined />,
    tone: 'warning',
  },
  {
    mode: 'allow-all',
    label: 'Never ask',
    description: 'Runs everything without asking · isolated environments only',
    icon: <UnlockOutlined />,
    tone: 'warning',
  },
];

// Gemini permission modes (Google Gemini SDK - native ApprovalMode values)
const GEMINI_MODES: ModeOption[] = [
  {
    mode: 'default',
    label: 'Manual',
    description: 'Asks before every tool use · for high-stakes changes',
    icon: <LockOutlined />,
    tone: 'danger',
  },
  {
    mode: 'autoEdit',
    label: 'Accept edits',
    description: 'Auto-approves file edits, asks for shell/web · for reviewed code',
    icon: <EditOutlined />,
    tone: 'success',
  },
  {
    mode: 'yolo',
    label: 'Bypass permissions',
    description: 'Runs everything without asking · isolated environments only',
    icon: <UnlockOutlined />,
    tone: 'warning',
  },
];

// Copilot autonomous permission modes.
const COPILOT_MODES: ModeOption[] = [
  {
    mode: 'default',
    label: 'Manual',
    description: 'Proxies every approval to Agor · for high-stakes changes',
    icon: <LockOutlined />,
    tone: 'danger',
  },
  {
    mode: 'acceptEdits',
    label: 'Accept edits',
    description: 'Auto-approves read/write, asks for shell/MCP · for reviewed code',
    icon: <EditOutlined />,
    tone: 'success',
  },
  {
    mode: 'bypassPermissions',
    label: 'Bypass permissions',
    description: 'Runs everything without asking · isolated environments only',
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
    description: "Cursor SDK runs on its own · Agor can't intercept approvals yet",
    icon: <UnlockOutlined />,
    tone: 'warning',
  },
];

// OpenCode permission modes (uses Gemini-like modes since OpenCode auto-approves)
const OPENCODE_MODES: ModeOption[] = [
  {
    mode: 'default',
    label: 'Manual',
    description: 'Asks before each operation · for high-stakes changes',
    icon: <LockOutlined />,
    tone: 'danger',
  },
  {
    mode: 'autoEdit',
    label: 'Auto',
    description: 'Auto-approves all operations · recommended for OpenCode',
    icon: <EditOutlined />,
    tone: 'success',
  },
  {
    mode: 'yolo',
    label: 'Bypass permissions',
    description: 'Fully bypasses permission checks · isolated environments only',
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

/** Human-readable label for a raw permission mode value (for inline summaries). */
export const getPermissionModeLabel = (
  tool: PermissionModeSelectorProps['agentic_tool'],
  mode: PermissionMode
): string => getModesForTool(tool).find((option) => option.mode === mode)?.label ?? mode;

/** Full option metadata (label/icon/tone) for a mode, for chip-style rendering. */
export const getPermissionModeMeta = (
  tool: PermissionModeSelectorProps['agentic_tool'],
  mode: PermissionMode
): ModeOption | undefined => getModesForTool(tool).find((option) => option.mode === mode);

export const getPermissionModeColor = (tone: ModeOption['tone'], token: GlobalToken): string =>
  getModeColor(tone, token);

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

  // Codex dual-control (compact only): sandbox + approval dropdowns
  // (used by SessionPanel for inline Codex controls).
  if (compact && agentic_tool === 'codex' && onCodexChange) {
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

  // Everything else is one rich Select. Full-width form contexts (non-compact)
  // show the two-part description and the raw mode value; tight toolbar
  // contexts (compact) collapse to an icon or plain label via `iconOnly`/`plain`.
  const effectiveFullWidth = fullWidth || !compact;
  const currentMode = modes.find((m) => m.mode === effectiveValue);
  return (
    <Tooltip
      title={currentMode ? `${currentMode.label} — ${currentMode.description}` : 'Permission mode'}
    >
      <Select
        value={effectiveValue}
        onChange={onChange}
        style={{ fontSize: token.fontSizeSM, width: effectiveFullWidth ? '100%' : undefined }}
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
          };
        })}
        optionRender={(option) => {
          const modeData = modes.find((m) => m.mode === option.value);
          if (!modeData) return null;
          const color = getModeColor(modeData.tone, token);
          return (
            <Flex
              justify="space-between"
              align="start"
              gap={12}
              style={{ minWidth: iconOnly ? undefined : 260 }}
            >
              <Space size={6} align="start">
                <span style={{ color }}>{modeData.icon}</span>
                {/* whiteSpace:normal lets the two-part description wrap instead
                    of truncating with antd's default option ellipsis. */}
                <div style={{ lineHeight: 1.3, whiteSpace: 'normal' }}>
                  <div style={{ color: modeData.tone === 'warning' ? color : undefined }}>
                    {modeData.label}
                  </div>
                  <Typography.Text type="secondary" style={{ fontSize: 11, whiteSpace: 'normal' }}>
                    {modeData.description}
                  </Typography.Text>
                </div>
              </Space>
              {!iconOnly && (
                <Typography.Text type="secondary" code style={{ fontSize: 11 }}>
                  {modeData.mode}
                </Typography.Text>
              )}
            </Flex>
          );
        }}
      />
    </Tooltip>
  );
};
