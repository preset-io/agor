import type { CodexApprovalPolicy, CodexSandboxMode, PermissionMode } from '@agor/core/types';
import {
  EditOutlined,
  ExperimentOutlined,
  LockOutlined,
  SafetyOutlined,
  UnlockOutlined,
} from '@ant-design/icons';
import { Radio, Select, Space, Typography } from 'antd';

export interface PermissionModeSelectorProps {
  value?: PermissionMode;
  onChange?: (value: PermissionMode) => void;
  agentic_tool?: 'claude-code' | 'codex' | 'gemini';
  /** If true, renders as a compact Select dropdown instead of Radio buttons */
  compact?: boolean;
  /** Size for compact mode */
  size?: 'small' | 'middle' | 'large';
  /** Width for compact mode */
  width?: number;
  /** Codex-specific: sandbox mode value */
  codexSandboxMode?: CodexSandboxMode;
  /** Codex-specific: approval policy value */
  codexApprovalPolicy?: CodexApprovalPolicy;
  /** Codex-specific: callback for dual permission changes */
  onCodexChange?: (sandbox: CodexSandboxMode, approval: CodexApprovalPolicy) => void;
}

// Claude Code permission modes (Claude Agent SDK)
const CLAUDE_CODE_MODES: {
  mode: PermissionMode;
  label: string;
  description: string;
  icon: React.ReactNode;
  color: string;
}[] = [
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
const CODEX_MODES: {
  mode: PermissionMode;
  label: string;
  description: string;
  icon: React.ReactNode;
  color: string;
}[] = [
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

// Gemini permission modes (Google Gemini SDK)
const GEMINI_MODES: {
  mode: PermissionMode;
  label: string;
  description: string;
  icon: React.ReactNode;
  color: string;
}[] = [
  {
    mode: 'default',
    label: 'default',
    description: 'Prompt for each tool use (most restrictive)',
    icon: <LockOutlined />,
    color: '#f5222d', // Red
  },
  {
    mode: 'acceptEdits',
    label: 'autoEdit',
    description: 'Auto-approve file edits, ask for shell/web tools',
    icon: <EditOutlined />,
    color: '#52c41a', // Green
  },
  {
    mode: 'bypassPermissions',
    label: 'yolo',
    description: 'Allow all operations without prompting',
    icon: <UnlockOutlined />,
    color: '#faad14', // Orange/yellow
  },
];

// Codex sandbox mode options
const CODEX_SANDBOX_MODES = [
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
const CODEX_APPROVAL_POLICIES = [
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

export const PermissionModeSelector: React.FC<PermissionModeSelectorProps> = ({
  value = 'auto',
  onChange,
  agentic_tool = 'claude-code',
  compact = false,
  size = 'middle',
  width = 200,
  codexSandboxMode = 'workspace-write',
  codexApprovalPolicy = 'on-request',
  onCodexChange,
}) => {
  // Select modes based on agentic tool type
  const modes =
    agentic_tool === 'codex'
      ? CODEX_MODES
      : agentic_tool === 'gemini'
        ? GEMINI_MODES
        : CLAUDE_CODE_MODES;

  // Get default value based on agentic tool type
  const defaultValue = agentic_tool === 'codex' ? 'auto' : 'acceptEdits';
  const effectiveValue = value || defaultValue;

  // Compact mode: render as Select dropdown(s)
  if (compact) {
    // Codex: Render 2 dropdowns (sandbox + approval)
    if (agentic_tool === 'codex') {
      return (
        <Space size={8}>
          <Select
            value={codexSandboxMode}
            onChange={(val) => onCodexChange?.(val, codexApprovalPolicy)}
            size={size}
            placeholder="Sandbox"
            popupMatchSelectWidth={false}
            style={{ minWidth: 100 }}
            options={CODEX_SANDBOX_MODES.map(({ value, label, description }) => ({
              label,
              value,
              title: description,
            }))}
          />
          <Select
            value={codexApprovalPolicy}
            onChange={(val) => onCodexChange?.(codexSandboxMode, val)}
            size={size}
            placeholder="Approval"
            popupMatchSelectWidth={false}
            style={{ minWidth: 100 }}
            options={CODEX_APPROVAL_POLICIES.map(({ value, label, description }) => ({
              label,
              value,
              title: description,
            }))}
          />
        </Space>
      );
    }

    // Claude/Gemini: Single dropdown
    return (
      <Select
        value={effectiveValue}
        onChange={onChange}
        style={{ minWidth: width || 120 }}
        size={size}
        suffixIcon={<SafetyOutlined />}
        popupMatchSelectWidth={false}
        options={modes.map(({ mode, label, description }) => ({
          label,
          value: mode,
          title: description,
        }))}
      />
    );
  }

  // Full mode: render as Radio group with descriptions
  return (
    <Radio.Group value={effectiveValue} onChange={(e) => onChange?.(e.target.value)}>
      <Space direction="vertical" style={{ width: '100%' }}>
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
