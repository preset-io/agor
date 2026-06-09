import type { Branch, Repo } from '@agor-live/client';
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
import { useConfirmNukeEnvironment } from '../../hooks/useConfirmNukeEnvironment';
import { getEffectiveEnv } from '../../utils/environmentConfig';
import { getEnvironmentState } from '../../utils/environmentState';
import type { BranchModalTab } from '../BranchModal/BranchModal';
import { Tag } from '../Tag';

interface BranchHeaderPillProps {
  repo: Repo;
  branch: Branch;
  sessionCount?: number;
  onOpenBranch?: (branchId: string, tab?: BranchModalTab) => void;
  onStartEnvironment?: (branchId: string) => void;
  onStopEnvironment?: (branchId: string) => void;
  onNukeEnvironment?: (branchId: string) => void;
  onViewLogs?: (branchId: string) => void;
  canControlEnvironment?: boolean;
  connectionDisabled?: boolean;
  /** Show environment status/controls and environment shortcut. Defaults to true. */
  showEnvButtons?: boolean;
  /**
   * Compact rendering for constrained side panels.
   * Hides the repo slug in the identity section and omits destructive environment actions.
   */
  compact?: boolean;
}

const PILL_HEIGHT = 22;

const iconButtonStyle: React.CSSProperties = {
  height: PILL_HEIGHT,
  width: PILL_HEIGHT,
  minWidth: PILL_HEIGHT,
  padding: 0,
};

export function BranchHeaderPill({
  repo,
  branch,
  sessionCount,
  onOpenBranch,
  onStartEnvironment,
  onStopEnvironment,
  onNukeEnvironment,
  onViewLogs,
  canControlEnvironment,
  connectionDisabled = false,
  showEnvButtons = true,
  compact = false,
}: BranchHeaderPillProps) {
  const { token } = theme.useToken();
  const confirmNuke = useConfirmNukeEnvironment();
  const effectiveEnv = getEffectiveEnv(repo);
  const hasConfig = effectiveEnv.hasConfig;
  const env = branch.environment_instance;
  const inferredState = getEnvironmentState(env);
  const environmentUrl = branch.app_url;
  // If a parent has loaded effective branch access (e.g. BranchModal), honor
  // that explicit decision. Otherwise do not infer from direct ownership or
  // `others_can`: group grants are not present on this branch payload, and the
  // daemon is the source of truth for environment authorization.
  const resolvedCanControlEnvironment = canControlEnvironment ?? true;
  const controlDisabledTooltip = resolvedCanControlEnvironment
    ? undefined
    : "Requires branch 'all' permission or admin access";

  const status = env?.status || 'stopped';
  const isRunning = status === 'running';
  const isStarting = status === 'starting';
  const isStopping = status === 'stopping';
  const canStop = status === 'running' || status === 'starting';
  const startDisabled =
    connectionDisabled ||
    !resolvedCanControlEnvironment ||
    !hasConfig ||
    !onStartEnvironment ||
    isStarting ||
    isStopping ||
    isRunning;
  const stopDisabled =
    connectionDisabled ||
    !resolvedCanControlEnvironment ||
    !hasConfig ||
    !onStopEnvironment ||
    isStopping ||
    !canStop;

  const openTab = (tab: BranchModalTab) => (e: React.MouseEvent) => {
    e.stopPropagation();
    onOpenBranch?.(branch.branch_id, tab);
  };

  const openModal = () => {
    onOpenBranch?.(branch.branch_id);
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

  const identityTooltip = compact
    ? `${repo.slug} / ${branch.name} · Open branch settings`
    : 'Open branch settings';

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
      <Tooltip title={identityTooltip}>
        <button
          type="button"
          onClick={openModal}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: compact ? '0 6px' : '0 8px',
            cursor: 'pointer',
            height: PILL_HEIGHT,
            background: 'none',
            border: 'none',
            color: 'inherit',
            font: 'inherit',
          }}
        >
          <BranchesOutlined style={{ fontSize: 12 }} />
          {!compact && (
            <>
              <span style={{ fontFamily: token.fontFamilyCode, fontSize: token.fontSizeSM }}>
                {repo.slug}
              </span>
              <ApartmentOutlined style={{ fontSize: 10, opacity: 0.6 }} />
            </>
          )}
          <span
            style={{
              fontFamily: token.fontFamilyCode,
              fontSize: token.fontSizeSM,
              maxWidth: compact ? 220 : 180,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {branch.name}
          </span>
        </button>
      </Tooltip>

      {/* Section 2: Environment status + controls */}
      {showEnvButtons && (
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
                <Tooltip
                  title={
                    controlDisabledTooltip ??
                    (isRunning ? 'Environment running' : 'Start environment')
                  }
                >
                  <Button
                    type="text"
                    size="small"
                    aria-label="Start environment"
                    icon={<PlayCircleOutlined />}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!startDisabled) onStartEnvironment(branch.branch_id);
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
                    controlDisabledTooltip ??
                    (isRunning
                      ? 'Stop environment'
                      : isStarting
                        ? 'Cancel startup'
                        : isStopping
                          ? 'Stopping...'
                          : 'Not running')
                  }
                >
                  <Button
                    type="text"
                    size="small"
                    aria-label="Stop environment"
                    icon={<StopOutlined />}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!stopDisabled) onStopEnvironment(branch.branch_id);
                    }}
                    disabled={stopDisabled}
                    style={iconButtonStyle}
                  />
                </Tooltip>
              )}

              {/* Logs button */}
              {onViewLogs && effectiveEnv.logs && (
                <Tooltip title={controlDisabledTooltip ?? 'View logs'}>
                  <Button
                    type="text"
                    size="small"
                    aria-label="View environment logs"
                    icon={<FileTextOutlined />}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (resolvedCanControlEnvironment) onViewLogs(branch.branch_id);
                    }}
                    disabled={!resolvedCanControlEnvironment}
                    style={iconButtonStyle}
                  />
                </Tooltip>
              )}

              {/* Nuke button */}
              {!compact && onNukeEnvironment && branch.nuke_command && (
                <Tooltip title={controlDisabledTooltip ?? 'Nuke environment (destructive)'}>
                  <Button
                    type="text"
                    size="small"
                    danger
                    aria-label="Nuke environment"
                    icon={<FireOutlined />}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (resolvedCanControlEnvironment && !connectionDisabled) {
                        confirmNuke(() => onNukeEnvironment(branch.branch_id));
                      }
                    }}
                    disabled={connectionDisabled || !resolvedCanControlEnvironment}
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
      )}

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
        <Tooltip title="Edit branch">
          <Button
            type="text"
            size="small"
            aria-label="Edit branch"
            icon={<EditOutlined />}
            onClick={(e) => {
              e.stopPropagation();
              openModal();
            }}
            style={iconButtonStyle}
          />
        </Tooltip>
      </div>
    </Tag>
  );
}
