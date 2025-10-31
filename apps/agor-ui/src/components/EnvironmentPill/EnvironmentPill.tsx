import type { Repo, Worktree } from '@agor/core/types';
import {
  CheckCircleOutlined,
  EditOutlined,
  GlobalOutlined,
  LoadingOutlined,
  PlayCircleOutlined,
  StopOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Button, Space, Tag, Tooltip, theme } from 'antd';

interface EnvironmentPillProps {
  repo: Repo; // Need repo for environment_config
  worktree: Worktree; // Has environment_instance (runtime state)
  onEdit?: () => void; // Opens WorktreeModal → Environment tab
  onStartEnvironment?: (worktreeId: string) => void;
  onStopEnvironment?: (worktreeId: string) => void;
}

export function EnvironmentPill({
  repo,
  worktree,
  onEdit,
  onStartEnvironment,
  onStopEnvironment,
}: EnvironmentPillProps) {
  const { token } = theme.useToken();
  const hasConfig = !!repo.environment_config;
  const env = worktree.environment_instance;

  // Get URL from backend-computed access_urls
  const environmentUrl =
    env?.access_urls && env.access_urls.length > 0 ? env.access_urls[0].url : undefined;

  // Case 1: No config at all - show grayed discovery pill
  if (!hasConfig) {
    return (
      <Tooltip title="Click to configure environment (optional)">
        <Tag
          color="default"
          style={{ cursor: 'pointer', userSelect: 'none', opacity: 0.6 }}
          onClick={(e) => {
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

  // Case 2 & 3: Config exists - show status
  const getStatusIcon = () => {
    if (!env || env.status === 'stopped') {
      return <StopOutlined style={{ color: '#8c8c8c', fontSize: 12 }} />;
    }
    switch (env.status) {
      case 'running':
        return <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 12 }} />;
      case 'error':
        return <WarningOutlined style={{ color: '#ff4d4f', fontSize: 12 }} />;
      case 'starting':
      case 'stopping':
        return <LoadingOutlined style={{ fontSize: 12 }} />;
      default:
        return <StopOutlined style={{ color: '#8c8c8c', fontSize: 12 }} />;
    }
  };

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    onEdit?.();
  };

  const status = env?.status || 'stopped';
  const isProcessing = status === 'starting' || status === 'stopping';
  const isRunning = status === 'running';
  const canStop = status === 'running' || status === 'starting';
  const startDisabled = !hasConfig || !onStartEnvironment || isProcessing || isRunning;
  const stopDisabled = !hasConfig || !onStopEnvironment || isProcessing || !canStop;

  // Build helpful tooltip based on state
  const getTooltipText = () => {
    if (!hasConfig) {
      return 'Click to configure environment';
    }

    switch (status) {
      case 'running':
        return environmentUrl
          ? `Running - ${environmentUrl} - click to open`
          : 'Running - click to configure';
      case 'starting':
        return environmentUrl ? `Starting... - ${environmentUrl}` : 'Starting...';
      case 'error':
        return 'Environment error - click to configure';
      default:
        return 'Stopped - click to configure';
    }
  };

  // Determine color based on status
  const getColor = () => {
    if (!env || env.status === 'stopped') return 'default';
    switch (env.status) {
      case 'running':
        return 'geekblue';
      case 'error':
        return 'red';
      case 'starting':
      case 'stopping':
        return 'blue';
      default:
        return 'default';
    }
  };

  return (
    <Tooltip title={getTooltipText()}>
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
            <a
              href={environmentUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
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
          ) : (
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
                    icon={isProcessing && status === 'starting' ? <LoadingOutlined /> : <PlayCircleOutlined />}
                    onClick={(event) => {
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
                      ? 'Environment is starting'
                      : 'Environment not running'
                  }
                >
                  <Button
                    type="text"
                    size="small"
                    icon={isProcessing && status === 'stopping' ? <LoadingOutlined /> : <StopOutlined />}
                    onClick={(event) => {
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
    </Tooltip>
  );
}
