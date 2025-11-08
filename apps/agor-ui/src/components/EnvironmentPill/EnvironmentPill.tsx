import type { Repo, Worktree } from '@agor/core/types';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  EditOutlined,
  FileTextOutlined,
  GlobalOutlined,
  PlayCircleOutlined,
  StopOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Button, Space, Spin, Tag, Tooltip, theme } from 'antd';
import { getEnvironmentState } from '../../utils/environmentState';

interface EnvironmentPillProps {
  repo: Repo; // Need repo for environment_config
  worktree: Worktree; // Has environment_instance (runtime state)
  onEdit?: () => void; // Opens WorktreeModal → Environment tab
  onStartEnvironment?: (worktreeId: string) => void;
  onStopEnvironment?: (worktreeId: string) => void;
  onViewLogs?: (worktreeId: string) => void;
}

export function EnvironmentPill({
  repo,
  worktree,
  onEdit,
  onStartEnvironment,
  onStopEnvironment,
  onViewLogs,
}: EnvironmentPillProps) {
  const { token } = theme.useToken();
  const hasConfig = !!repo.environment_config;
  const env = worktree.environment_instance;

  // Get static app_url (user-editable, initialized from template)
  const environmentUrl = worktree.app_url;

  // Case 1: No config at all - show grayed discovery pill
  if (!hasConfig) {
    return (
      <Tooltip title="Click to configure environment (optional)">
        <Tag
          color="default"
          style={{ cursor: 'pointer', userSelect: 'none', opacity: 0.6 }}
          onClick={e => {
            e.stopPropagation();
            onEdit?.();
          }}
        >
          <Space size={4}>
            <GlobalOutlined style={{ fontSize: 12 }} />
            <span style={{ fontFamily: token.fontFamilyCode }}>env</span>
            <EditOutlined style={{ fontSize: 12 }} />
          </Space>
        </Tag>
      </Tooltip>
    );
  }

  // Infer environment state by combining runtime status + health check
  const inferredState = getEnvironmentState(env);

  // Case 2 & 3: Config exists - show status with health awareness
  const getStatusIcon = () => {
    switch (inferredState) {
      case 'stopped':
        return <StopOutlined style={{ color: token.colorTextDisabled, fontSize: 12 }} />;
      case 'starting':
      case 'stopping':
        return <Spin size="small" />;
      case 'healthy':
        return <CheckCircleOutlined style={{ color: token.colorSuccess, fontSize: 12 }} />;
      case 'unhealthy':
        return <WarningOutlined style={{ color: token.colorWarning, fontSize: 12 }} />;
      case 'running':
        return <CheckCircleOutlined style={{ color: token.colorInfo, fontSize: 12 }} />;
      case 'error':
        return <CloseCircleOutlined style={{ color: token.colorError, fontSize: 12 }} />;
      default:
        return <StopOutlined style={{ color: token.colorTextDisabled, fontSize: 12 }} />;
    }
  };

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    onEdit?.();
  };

  const status = env?.status || 'stopped';
  const isRunning = status === 'running';
  const isStarting = status === 'starting';
  const isStopping = status === 'stopping';
  const canStop = status === 'running' || status === 'starting';
  const startDisabled = !hasConfig || !onStartEnvironment || isStarting || isStopping || isRunning;
  const stopDisabled = !hasConfig || !onStopEnvironment || isStopping || !canStop;

  // Build helpful tooltip based on inferred state
  const getTooltipText = () => {
    if (!hasConfig) {
      return 'Click to configure environment';
    }

    const healthCheck = env?.last_health_check;
    const healthMessage = healthCheck?.message ? ` - ${healthCheck.message}` : '';

    switch (inferredState) {
      case 'healthy':
        return environmentUrl
          ? `Healthy - ${environmentUrl}${healthMessage}`
          : `Healthy${healthMessage}`;
      case 'unhealthy':
        return environmentUrl
          ? `Unhealthy - ${environmentUrl}${healthMessage}`
          : `Unhealthy - check failed${healthMessage}`;
      case 'running':
        return environmentUrl
          ? `Running - ${environmentUrl} (health check not configured)`
          : 'Running (health check not configured)';
      case 'starting':
        return environmentUrl ? `Starting... - ${environmentUrl}` : 'Starting...';
      case 'stopping':
        return 'Stopping...';
      case 'error':
        return 'Failed to start - click to configure';
      default:
        return 'Stopped - click to configure';
    }
  };

  // Determine color based on inferred state
  const getColor = () => {
    switch (inferredState) {
      case 'healthy':
        return 'green'; // Green for healthy
      case 'unhealthy':
        return 'orange'; // Orange for unhealthy
      case 'running':
        return 'blue'; // Blue for running without health check
      case 'starting':
      case 'stopping':
        return 'blue'; // Blue for transitioning
      case 'error':
        return 'red'; // Red for errors
      default:
        return 'default'; // Gray for stopped
    }
  };

  return (
    <Tag
      color={getColor()}
      style={{
        userSelect: 'none',
        padding: 0,
        overflow: 'hidden',
        lineHeight: '20px',
        display: 'inline-flex',
        alignItems: 'stretch',
      }}
    >
      <Space
        size={0}
        style={{ width: '100%', display: 'inline-flex', alignItems: 'center' }}
        direction="horizontal"
      >
        {/* Left section - clickable to open URL (when running) */}
        {env?.status === 'running' && environmentUrl ? (
          <Tooltip title={`Open environment - ${environmentUrl}`}>
            <a
              href={environmentUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                color: 'inherit',
                padding: '0 7px',
                textDecoration: 'none',
                height: '22px',
              }}
            >
              <Space size={4} align="center">
                {getStatusIcon()}
                <span style={{ fontFamily: token.fontFamilyCode, lineHeight: 1 }}>env</span>
              </Space>
            </a>
          </Tooltip>
        ) : (
          <Tooltip title={getTooltipText()}>
            <div
              style={{
                padding: '0 7px',
                height: '22px',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              <Space size={4} align="center">
                {getStatusIcon()}
                <span style={{ fontFamily: token.fontFamilyCode, lineHeight: 1 }}>env</span>
              </Space>
            </div>
          </Tooltip>
        )}

        {/* Environment controls */}
        {(onStartEnvironment || onStopEnvironment) && hasConfig && (
          <Space
            size={2}
            style={{
              padding: '0 6px',
              borderLeft: '1px solid rgba(255, 255, 255, 0.2)',
              height: '22px',
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            {onStartEnvironment && (
              <Tooltip title={status === 'running' ? 'Environment running' : 'Start environment'}>
                <Button
                  type="text"
                  size="small"
                  icon={<PlayCircleOutlined />}
                  onClick={event => {
                    event.stopPropagation();
                    if (!startDisabled) {
                      onStartEnvironment(worktree.worktree_id);
                    }
                  }}
                  disabled={startDisabled}
                  style={{
                    height: 22,
                    width: 22,
                    minWidth: 22,
                    padding: 0,
                  }}
                />
              </Tooltip>
            )}
            {onStopEnvironment && (
              <Tooltip
                title={
                  status === 'running'
                    ? 'Stop environment'
                    : status === 'starting'
                      ? 'Stop environment (cancel startup)'
                      : status === 'stopping'
                        ? 'Environment is stopping'
                        : 'Environment not running'
                }
              >
                <Button
                  type="text"
                  size="small"
                  icon={<StopOutlined />}
                  onClick={event => {
                    event.stopPropagation();
                    if (!stopDisabled) {
                      onStopEnvironment(worktree.worktree_id);
                    }
                  }}
                  disabled={stopDisabled}
                  style={{
                    height: 22,
                    width: 22,
                    minWidth: 22,
                    padding: 0,
                  }}
                />
              </Tooltip>
            )}
            {onViewLogs && (
              <Tooltip
                title={
                  !repo.environment_config?.logs_command
                    ? 'Configure logs command to enable'
                    : 'View environment logs'
                }
              >
                <Button
                  type="text"
                  size="small"
                  icon={<FileTextOutlined />}
                  onClick={event => {
                    event.stopPropagation();
                    if (repo.environment_config?.logs_command) {
                      onViewLogs(worktree.worktree_id);
                    }
                  }}
                  disabled={!repo.environment_config?.logs_command}
                  style={{
                    height: 22,
                    width: 22,
                    minWidth: 22,
                    padding: 0,
                  }}
                />
              </Tooltip>
            )}
          </Space>
        )}

        {/* Edit button - always visible */}
        <Tooltip title="Configure environment">
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            onClick={handleEdit}
            style={{
              padding: 0,
              height: 22,
              width: 22,
              minWidth: 22,
              borderLeft: '1px solid rgba(255, 255, 255, 0.2)',
            }}
          />
        </Tooltip>
      </Space>
    </Tag>
  );
}
