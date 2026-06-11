import type {
  AgorClient,
  CodexApprovalPolicy,
  CodexSandboxMode,
  EffortLevel,
  PermissionMode,
  Session,
} from '@agor-live/client';
import { RobotOutlined, SettingOutlined } from '@ant-design/icons';
import { Popover, Space, Typography, theme } from 'antd';
import type React from 'react';
import { EffortSelector } from '../EffortSelector';
import { type ModelConfig, ModelSelector } from '../ModelSelector';
import { PermissionModeSelector } from '../PermissionModeSelector';
import { getModelDisplayName } from '../Pill/modelDisplay';
import { Tag } from '../Tag';

export interface SessionRunSettingsPopoverProps {
  client: AgorClient | null;
  session: Session;
  modelLabel?: string;
  modelConfig?: ModelConfig;
  onModelConfigChange: (config: ModelConfig) => void;
  effortLevel: EffortLevel;
  onEffortChange: (effort: EffortLevel) => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  codexSandboxMode: CodexSandboxMode;
  codexApprovalPolicy: CodexApprovalPolicy;
  onCodexPermissionChange: (sandbox: CodexSandboxMode, approval: CodexApprovalPolicy) => void;
}

export const SessionRunSettingsPopover: React.FC<SessionRunSettingsPopoverProps> = ({
  client,
  session,
  modelLabel,
  modelConfig,
  onModelConfigChange,
  effortLevel,
  onEffortChange,
  permissionMode,
  onPermissionModeChange,
  codexSandboxMode,
  codexApprovalPolicy,
  onCodexPermissionChange,
}) => {
  const { token } = theme.useToken();

  const content = (
    <div style={{ width: 320, maxWidth: 'min(320px, 80vw)' }}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <div>
          <Typography.Text strong>Quick session settings</Typography.Text>
        </div>

        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Model
          </Typography.Text>
          <div style={{ marginTop: token.sizeUnit }}>
            <ModelSelector
              value={modelConfig}
              onChange={onModelConfigChange}
              agentic_tool={session.agentic_tool}
              client={client}
              compact
            />
          </div>
        </div>

        {session.agentic_tool === 'claude-code' && (
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Reasoning effort
            </Typography.Text>
            <div style={{ marginTop: token.sizeUnit }}>
              <EffortSelector
                value={effortLevel}
                onChange={onEffortChange}
                size="small"
                compact
                plain
                fullWidth
              />
            </div>
          </div>
        )}

        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Permissions
          </Typography.Text>
          <div style={{ marginTop: token.sizeUnit }}>
            <PermissionModeSelector
              value={permissionMode}
              onChange={onPermissionModeChange}
              agentic_tool={session.agentic_tool}
              codexSandboxMode={codexSandboxMode}
              codexApprovalPolicy={codexApprovalPolicy}
              onCodexChange={onCodexPermissionChange}
              compact
              iconOnly={false}
              plain
              fullWidth
              size="small"
            />
          </div>
        </div>
      </Space>
    </div>
  );

  const trigger = modelLabel ? (
    <Tag
      icon={<RobotOutlined />}
      color="default"
      title="Model and run settings"
      style={{ cursor: 'pointer', height: 22, display: 'inline-flex', alignItems: 'center' }}
    >
      <span>{getModelDisplayName(modelLabel)}</span>
      <SettingOutlined style={{ marginLeft: token.sizeUnit * 1.5 }} />
    </Tag>
  ) : (
    <Tag
      icon={<SettingOutlined />}
      color="default"
      style={{ cursor: 'pointer', height: 22, display: 'inline-flex', alignItems: 'center' }}
    >
      Run
    </Tag>
  );

  return (
    <Popover
      trigger="click"
      placement="top"
      getPopupContainer={(node) => node.parentElement ?? document.body}
      content={content}
      title={null}
    >
      {trigger}
    </Popover>
  );
};
