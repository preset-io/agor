import type { Repo, Worktree } from '@agor-live/client';
import {
  ApartmentOutlined,
  BranchesOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  EditOutlined,
  FileTextOutlined,
  FireOutlined,
  FolderOutlined,
  GlobalOutlined,
  PlayCircleOutlined,
  StopOutlined,
  TeamOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Button, Spin, Tooltip, theme } from 'antd';
import { getEnvironmentState } from '../../utils/environmentState';
import { Tag } from '../Tag';
import type { WorktreeModalTab } from '../WorktreeModal/WorktreeModal';

interface WorktreeHeaderPillProps {
  repo: Repo;
  worktree: Worktree;
  sessionCount?: number;
  onOpenWorktree?: (worktreeId: string, tab?: WorktreeModalTab) => void;
  onStartEnvironment?: (worktreeId: string) => void;
  onStopEnvironment?: (worktreeId: string) => void;
  onNukeEnvironment?: (worktreeId: string) => void;
  onViewLogs?: (worktreeId: string) => void;
  connectionDisabled?: boolean;
}

const PILL_HEIGHT = 22;

const iconButtonStyle: React.CSSProperties = {
  height: PILL_HEIGHT,
  width: PILL_HEIGHT,
  minWidth: PILL_HEIGHT,
  padding: 0,
};

export function WorktreeHeaderPill({
  repo,
  worktree,
  sessionCount,
  onOpenWorktree,
  onStartEnvironment,
  onStopEnvironment,
  onNukeEnvironment,
  onViewLogs,
  connectionDisabled = false,
}: WorktreeHeaderPillProps) {
  const { token } = theme.useToken();
  const hasConfig = !!repo.environment_config;
  const env = worktree.environment_instance;
  const inferredState = getEnvironmentState(env);
  const environmentUrl = worktree.app_url;

  const status = env?.status || 'stopped';
  const isRunning = status === 'running';
  const isStarting = status === 'starting';
  const isStopping = status === 'stopping';
  const canStop = status === 'running' || status === 'starting';
  const startDisabled =
    connectionDisabled ||
    !hasConfig ||
    !onStartEnvironment ||
    isStarting ||
    isStopping ||
    isRunning;
  const stopDisabled =
    connectionDisabled || !hasConfig || !onStopEnvironment || isStopping || !canStop;

  const openTab = (tab: WorktreeModalTab) => (e: React.MouseEvent) => {
    e.stopPropagation();
    onOpenWorktree?.(worktree.worktree_id, tab);
  };

  const openModal = () => {
    onOpenWorktree?.(worktree.worktree_id);
  };

  // --- Environment status helpers ---

  const getStatusIcon = () => {
    const size = 11;
    switch (inferredState) {
      case 'stopped':
        return <StopOutlined style={{ color: token.colorTextDisabled, fontSize: size }} />;
      case 'starting':
      case 'stopping':
        return <Spin size="small" style={{ fontSize: size }} />;
      case 'healthy':
        return <CheckCircleOutlined style={{ color: token.colorSuccess, fontSize: size }} />;
      case 'unhealthy':
        return <WarningOutlined style={{ color: token.colorWarning, fontSize: size }} />;
      case 'running':
        return <CheckCircleOutlined style={{ color: token.colorInfo, fontSize: size }} />;
      case 'error':
        return <CloseCircleOutlined style={{ color: token.colorError, fontSize: size }} />;
      default:
        return <StopOutlined style={{ color: token.colorTextDisabled, fontSize: size }} />;
    }
  };

  const getEnvTooltip = () => {
    if (!hasConfig) return 'Click to configure environment';
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
          : `Unhealthy${healthMessage}`;
      case 'running':
        return environmentUrl ? `Running - ${environmentUrl}` : 'Running (no health check)';
      case 'starting':
        return 'Starting...';
      case 'stopping':
        return 'Stopping...';
      case 'error':
        return 'Failed to start';
      default:
        return 'Stopped';
    }
  };

  // --- Render ---

  return (
    <Tag
      color="cyan"
      style={{
        userSelect: 'none',
        padding: 0,
        overflow: 'hidden',
        lineHeight: `${PILL_HEIGHT}px`,
        display: 'inline-flex',
        alignItems: 'stretch',
        cursor: 'default',
      }}
    >
      {/* Section 1: Repo + Branch — click opens modal (General tab) */}
      <Tooltip title="Open worktree settings">
        <button
          type="button"
          onClick={openModal}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '0 8px',
            cursor: 'pointer',
            height: PILL_HEIGHT,
            background: 'none',
            border: 'none',
            color: 'inherit',
            font: 'inherit',
          }}
        >
          <BranchesOutlined style={{ fontSize: 12 }} />
          <span style={{ fontFamily: token.fontFamilyCode, fontSize: token.fontSizeSM }}>
            {repo.slug}
          </span>
          <ApartmentOutlined style={{ fontSize: 10, opacity: 0.6 }} />
          <span
            style={{
              fontFamily: token.fontFamilyCode,
              fontSize: token.fontSizeSM,
              maxWidth: 180,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {worktree.name}
          </span>
        </button>
      </Tooltip>

      {/* Section 2: Environment status + controls */}
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 2,
          padding: '0 4px',
          height: PILL_HEIGHT,
          borderLeft: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        {hasConfig ? (
          <>
            {/* Env label — clickable to env URL when running, otherwise opens env tab */}
            {isRunning && environmentUrl ? (
              <Tooltip title={`Open ${environmentUrl}`}>
                <a
                  href={environmentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                    color: 'inherit',
                    textDecoration: 'none',
                    padding: '0 2px',
                  }}
                >
                  {getStatusIcon()}
                  <span style={{ fontFamily: token.fontFamilyCode, fontSize: 11 }}>env</span>
                </a>
              </Tooltip>
            ) : (
              <Tooltip title={getEnvTooltip()}>
                <button
                  type="button"
                  onClick={openTab('environment')}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                    cursor: 'pointer',
                    padding: '0 2px',
                    background: 'none',
                    border: 'none',
                    color: 'inherit',
                    font: 'inherit',
                  }}
                >
                  {getStatusIcon()}
                  <span style={{ fontFamily: token.fontFamilyCode, fontSize: 11 }}>env</span>
                </button>
              </Tooltip>
            )}

            {/* Play button */}
            {onStartEnvironment && (
              <Tooltip title={isRunning ? 'Environment running' : 'Start environment'}>
                <Button
                  type="text"
                  size="small"
                  aria-label="Start environment"
                  icon={<PlayCircleOutlined />}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!startDisabled) onStartEnvironment(worktree.worktree_id);
                  }}
                  disabled={startDisabled}
                  style={iconButtonStyle}
                />
              </Tooltip>
            )}

            {/* Stop button */}
            {onStopEnvironment && (
              <Tooltip
                title={
                  isRunning
                    ? 'Stop environment'
                    : isStarting
                      ? 'Cancel startup'
                      : isStopping
                        ? 'Stopping...'
                        : 'Not running'
                }
              >
                <Button
                  type="text"
                  size="small"
                  aria-label="Stop environment"
                  icon={<StopOutlined />}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!stopDisabled) onStopEnvironment(worktree.worktree_id);
                  }}
                  disabled={stopDisabled}
                  style={iconButtonStyle}
                />
              </Tooltip>
            )}

            {/* Logs button */}
            {onViewLogs && repo.environment_config?.logs_command && (
              <Tooltip title="View logs">
                <Button
                  type="text"
                  size="small"
                  aria-label="View environment logs"
                  icon={<FileTextOutlined />}
                  onClick={(e) => {
                    e.stopPropagation();
                    onViewLogs(worktree.worktree_id);
                  }}
                  style={iconButtonStyle}
                />
              </Tooltip>
            )}

            {/* Nuke button */}
            {onNukeEnvironment && worktree.nuke_command && (
              <Tooltip title="Nuke environment (destructive)">
                <Button
                  type="text"
                  size="small"
                  danger
                  aria-label="Nuke environment"
                  icon={<FireOutlined />}
                  onClick={(e) => {
                    e.stopPropagation();
                    onNukeEnvironment(worktree.worktree_id);
                  }}
                  disabled={connectionDisabled}
                  style={iconButtonStyle}
                />
              </Tooltip>
            )}
          </>
        ) : (
          /* No env config — show dim env label with edit icon */
          <Tooltip title="Configure environment">
            <button
              type="button"
              onClick={openTab('environment')}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                cursor: 'pointer',
                opacity: 0.5,
                padding: '0 2px',
                background: 'none',
                border: 'none',
                color: 'inherit',
                font: 'inherit',
              }}
            >
              <GlobalOutlined style={{ fontSize: 11 }} />
              <span style={{ fontFamily: token.fontFamilyCode, fontSize: 11 }}>env</span>
            </button>
          </Tooltip>
        )}
      </div>

      {/* Section 3: Tab shortcut icons */}
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 1,
          padding: '0 3px',
          height: PILL_HEIGHT,
          borderLeft: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Tooltip title={`Sessions${sessionCount != null ? ` (${sessionCount})` : ''}`}>
          <Button
            type="text"
            size="small"
            aria-label="Sessions"
            icon={<TeamOutlined />}
            onClick={openTab('sessions')}
            style={iconButtonStyle}
          />
        </Tooltip>
        <Tooltip title="Files">
          <Button
            type="text"
            size="small"
            aria-label="Files"
            icon={<FolderOutlined />}
            onClick={openTab('files')}
            style={iconButtonStyle}
          />
        </Tooltip>
        <Tooltip title="Schedule">
          <Button
            type="text"
            size="small"
            aria-label="Schedule"
            icon={<CalendarOutlined />}
            onClick={openTab('schedule')}
            style={iconButtonStyle}
          />
        </Tooltip>
        <Tooltip title="Edit environment">
          <Button
            type="text"
            size="small"
            aria-label="Edit environment"
            icon={<EditOutlined />}
            onClick={openTab('environment')}
            style={iconButtonStyle}
          />
        </Tooltip>
      </div>
    </Tag>
  );
}
