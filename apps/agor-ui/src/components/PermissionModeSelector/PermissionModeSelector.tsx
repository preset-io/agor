import type { CodexApprovalPolicy, CodexSandboxMode, PermissionMode } from '@agor-live/client';
import {
  EditOutlined,
  ExperimentOutlined,
  LockOutlined,
  SafetyOutlined,
  UnlockOutlined,
} from '@ant-design/icons';
import { Radio, Select, Space, Typography } from 'antd';

interface ModeOption {
  mode: PermissionMode;
  label: string;
  description: string;
  icon: React.ReactNode;
  color: string;
}

export interface PermissionModeSelectorProps {
  value?: PermissionMode;
  onChange?: (value: PermissionMode) => void;
  agentic_tool?: 'claude-code' | 'codex' | 'gemini' | 'opencode' | 'copilot';
  /** If true, renders as a compact Select dropdown instead of Radio buttons */
  compact?: boolean;
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
    color: '#f5222d', // Red
  },
  {
    mode: 'acceptEdits',
    label: 'acceptEdits',
    description: 'Auto-accept file edits, ask for other tools (recommended)',
    icon: <EditOutlined />,
    color: '#52c41a', // Green
  },
  {
    mode: 'bypassPermissions',
    label: 'bypassPermissions',
    description: 'Allow all operations without prompting',
    icon: <UnlockOutlined />,
    color: '#faad14', // Orange/yellow
  },
  {
    mode: 'plan',
    label: 'plan',
    description: 'Generate plan without executing',
    icon: <ExperimentOutlined />,
    color: '#1890ff', // Blue
  },
];

// Codex permission modes (OpenAI Codex SDK)
const CODEX_MODES: ModeOption[] = [
  {
    mode: 'ask',
    label: 'untrusted',
    description: 'Only run trusted commands (ls, cat, sed) without approval',
    icon: <LockOutlined />,
    color: '#f5222d', // Red
  },
  {
    mode: 'auto',
    label: 'on-request',
    description: 'Model decides when to ask for approval',
    icon: <SafetyOutlined />,
    color: '#52c41a', // Green
  },
  {
    mode: 'on-failure',
    label: 'on-failure',
    description: 'Run all commands, ask only when they fail',
    icon: <EditOutlined />,
    color: '#faad14', // Orange/yellow
  },
  {
    mode: 'allow-all',
    label: 'never',
    description: 'Never ask for approval, failures returned to model',
    icon: <UnlockOutlined />,
    color: '#722ed1', // Purple
  },
];

// Gemini permission modes (Google Gemini SDK - native ApprovalMode values)
const GEMINI_MODES: ModeOption[] = [
  {
    mode: 'default',
    label: 'default',
    description: 'Prompt for each tool use (most restrictive)',
    icon: <LockOutlined />,
    color: '#f5222d', // Red
  },
  {
    mode: 'autoEdit',
    label: 'autoEdit',
    description: 'Auto-approve file edits, ask for shell/web tools',
    icon: <EditOutlined />,
    color: '#52c41a', // Green
  },
  {
    mode: 'yolo',
    label: 'yolo',
    description: 'Allow all operations without prompting',
    icon: <UnlockOutlined />,
    color: '#faad14', // Orange/yellow
  },
];

// Copilot permission modes (GitHub Copilot SDK - same semantics as Claude Code)
const COPILOT_MODES: ModeOption[] = [
  {
    mode: 'default',
    label: 'default',
    description: 'Proxy all permission requests to Agor UI for approval',
    icon: <LockOutlined />,
    color: '#f5222d', // Red
  },
  {
    mode: 'acceptEdits',
    label: 'acceptEdits',
    description: 'Auto-approve read/write operations, ask for shell/MCP (recommended)',
    icon: <EditOutlined />,
    color: '#52c41a', // Green
  },
  {
    mode: 'bypassPermissions',
    label: 'bypassPermissions',
    description: 'Auto-approve all operations without prompting',
    icon: <UnlockOutlined />,
    color: '#faad14', // Orange/yellow
  },
];

// OpenCode permission modes (uses Gemini-like modes since OpenCode auto-approves)
const OPENCODE_MODES: ModeOption[] = [
  {
    mode: 'default',
    label: 'default',
    description: 'Prompt for approval before each operation',
    icon: <LockOutlined />,
    color: '#f5222d', // Red
  },
  {
    mode: 'autoEdit',
    label: 'autoEdit',
    description: 'Auto-approve all operations (recommended)',
    icon: <EditOutlined />,
    color: '#52c41a', // Green
  },
  {
    mode: 'yolo',
    label: 'yolo',
    description: 'Fully bypass all permission checks',
    icon: <UnlockOutlined />,
    color: '#faad14', // Orange/yellow
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
    default:
      return CLAUDE_CODE_MODES;
  }
};

/** Get the default permission mode for a given agentic tool */
const getDefaultMode = (tool: PermissionModeSelectorProps['agentic_tool']): PermissionMode => {
  switch (tool) {
    case 'codex':
      return 'auto';
    case 'gemini':
    case 'opencode':
      return 'autoEdit';
    default:
      return 'acceptEdits';
  }
};

export const PermissionModeSelector: React.FC<PermissionModeSelectorProps> = ({
  value,
  onChange,
  agentic_tool = 'claude-code',
  compact = false,
  size = 'middle',
  codexSandboxMode = 'workspace-write',
  codexApprovalPolicy = 'on-request',
  onCodexChange,
}) => {
  const modes = getModesForTool(agentic_tool);
  const effectiveValue = value || getDefaultMode(agentic_tool);

  // Compact mode: render as Select dropdown(s)
  if (compact) {
    // Codex with onCodexChange: render sandbox + approval dropdowns
    // (used by SessionPanel for inline Codex controls)
    if (agentic_tool === 'codex' && onCodexChange) {
      return (
        <Space size={8}>
          <Select
            value={codexSandboxMode}
            onChange={(val) => onCodexChange(val, codexApprovalPolicy)}
            size={size}
            placeholder="Sandbox"
            popupMatchSelectWidth={false}
            style={{ minWidth: 80 }}
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
            value={codexApprovalPolicy}
            onChange={(val) => onCodexChange(codexSandboxMode, val)}
            size={size}
            placeholder="Approval"
            popupMatchSelectWidth={false}
            style={{ minWidth: 80 }}
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
    // Show only label in the selected value, but label + description in dropdown options
    return (
      <Select
        value={effectiveValue}
        onChange={onChange}
        style={{ width: '100%' }}
        size={size}
        popupMatchSelectWidth={false}
        optionLabelProp="label"
        options={modes.map(({ mode, label, description, icon, color }) => ({
          label,
          value: mode,
          title: description,
          icon,
          color,
        }))}
        optionRender={(option) => {
          const modeData = modes.find((m) => m.mode === option.value);
          return (
            <Space size={6} align="start">
              {modeData && <span style={{ color: modeData.color }}>{modeData.icon}</span>}
              <div style={{ lineHeight: 1.3 }}>
                <div>{option.label}</div>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {option.data.title}
                </Typography.Text>
              </div>
            </Space>
          );
        }}
      />
    );
  }

  // Full mode: render as Radio group with descriptions
  return (
    <Radio.Group value={effectiveValue} onChange={(e) => onChange?.(e.target.value)}>
      <Space orientation="vertical" style={{ width: '100%' }}>
        {modes.map(({ mode, label, description, icon, color }) => (
          <Radio key={mode} value={mode}>
            <Space>
              <span style={{ color }}>{icon}</span>
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
