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
import { Link } from 'react-router-dom';
import { useConfirmNukeEnvironment } from '../../hooks/useConfirmNukeEnvironment';
import { getEffectiveEnv } from '../../utils/environmentConfig';
import { getEnvironmentState } from '../../utils/environmentState';
import type { BranchModalTab } from '../BranchModal/BranchModal';
import { ENTITY_PILL_COLORS } from '../Pill/Pill';
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
  /** Whether to show the destructive Nuke action when available. Defaults to true. */
  showNukeEnvironment?: boolean;
  /** Optional link for the branch identity area. Used by session surfaces for deep links. */
  identityLink?: string | null;
  /** Fill the available row width and let the identity shrink before action sections. */
  fluid?: boolean;
  /**
   * Compact rendering for constrained side panels.
   * Hides the repo slug in the identity section and omits destructive environment actions.
   */
  compact?: boolean;
}

const PILL_HEIGHT = 22;
const ACTION_BUTTON_HEIGHT = 22;
const DEFAULT_ACTION_BUTTON_WIDTH = 22;

const DEFAULT_ACTION_BUTTON_STYLE: React.CSSProperties = {
  height: ACTION_BUTTON_HEIGHT,
  width: DEFAULT_ACTION_BUTTON_WIDTH,
  minWidth: DEFAULT_ACTION_BUTTON_WIDTH,
  padding: 0,
};

// The configured environment and shortcut sections cannot shrink. Reclaim two
// pixels per action only in the constrained, non-compact fluid layout so the
// complete action row fits before identity text collapses to its ellipsis.
const FLUID_ACTION_BUTTON_WIDTH = 20;
const FLUID_ACTION_BUTTON_STYLE: React.CSSProperties = {
  height: ACTION_BUTTON_HEIGHT,
  width: FLUID_ACTION_BUTTON_WIDTH,
  minWidth: FLUID_ACTION_BUTTON_WIDTH,
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
  showNukeEnvironment = true,
  identityLink,
  fluid = false,
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
  const actionButtonStyle =
    fluid && !compact ? FLUID_ACTION_BUTTON_STYLE : DEFAULT_ACTION_BUTTON_STYLE;

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

  const identityContent = (
    <>
      <BranchesOutlined style={{ fontSize: 12, flexShrink: 0 }} />
      {!compact && (
        <>
          <span
            style={{
              fontFamily: token.fontFamilyCode,
              fontSize: token.fontSizeSM,
              ...(fluid
                ? {
                    flex: '0 1 auto',
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }
                : {}),
            }}
          >
            {repo.slug}
          </span>
          <ApartmentOutlined style={{ fontSize: 10, opacity: 0.6, flexShrink: 0 }} />
        </>
      )}
      <span
        style={{
          fontFamily: token.fontFamilyCode,
          fontSize: token.fontSizeSM,
          ...(fluid ? { flex: '1 1 auto', minWidth: 0 } : { maxWidth: compact ? 220 : 180 }),
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {branch.name}
      </span>
    </>
  );

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

  const identityTooltip = `${repo.slug} / ${branch.name} · ${identityLink ? 'Open session' : 'Open branch settings'}`;
  const identityLinkStyle: React.CSSProperties = {
    display: fluid ? 'flex' : 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: compact ? '0 6px' : '0 8px',
    cursor: 'pointer',
    height: PILL_HEIGHT,
    color: 'inherit',
    textDecoration: 'none',
    ...(fluid ? { flex: '1 1 auto', minWidth: 0, overflow: 'hidden' } : {}),
  };
  const isInternalIdentityLink = identityLink?.startsWith('/');

  // --- Render ---

  return (
    <Tag
      color={ENTITY_PILL_COLORS.branch}
      style={{
        userSelect: 'none',
        padding: 0,
        overflow: 'hidden',
        lineHeight: `${PILL_HEIGHT}px`,
        display: fluid ? 'flex' : 'inline-flex',
        alignItems: 'stretch',
        cursor: 'default',
        ...(fluid ? { width: '100%', minWidth: 0, maxWidth: '100%' } : {}),
      }}
    >
      {/* Section 1: Repo + Branch — click opens either the supplied identity URL or the branch modal. */}
      <Tooltip title={identityTooltip} trigger={['hover', 'focus']}>
        {identityLink && isInternalIdentityLink ? (
          <Link
            to={identityLink}
            aria-label={identityTooltip}
            onClick={(e) => e.stopPropagation()}
            style={identityLinkStyle}
          >
            {identityContent}
          </Link>
        ) : identityLink ? (
          <a
            href={identityLink}
            aria-label={identityTooltip}
            onClick={(e) => e.stopPropagation()}
            style={identityLinkStyle}
          >
            {identityContent}
          </a>
        ) : (
          <button
            type="button"
            aria-label={identityTooltip}
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
              ...(fluid ? { flex: '1 1 auto', minWidth: 0, overflow: 'hidden' } : {}),
            }}
          >
            {identityContent}
          </button>
        )}
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
            flexShrink: 0,
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
                    style={actionButtonStyle}
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
                    style={actionButtonStyle}
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
                    style={actionButtonStyle}
                  />
                </Tooltip>
              )}

              {/* Nuke button */}
              {showNukeEnvironment && !compact && onNukeEnvironment && branch.nuke_command && (
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
                    style={actionButtonStyle}
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
          flexShrink: 0,
        }}
      >
        <Tooltip title={`Sessions${sessionCount != null ? ` (${sessionCount})` : ''}`}>
          <Button
            type="text"
            size="small"
            aria-label="Sessions"
            icon={<TeamOutlined />}
            onClick={openTab('sessions')}
            style={actionButtonStyle}
          />
        </Tooltip>
        <Tooltip title="Files">
          <Button
            type="text"
            size="small"
            aria-label="Files"
            icon={<FolderOutlined />}
            onClick={openTab('files')}
            style={actionButtonStyle}
          />
        </Tooltip>
        <Tooltip title="Schedule">
          <Button
            type="text"
            size="small"
            aria-label="Schedule"
            icon={<CalendarOutlined />}
            onClick={openTab('schedule')}
            style={actionButtonStyle}
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
            style={actionButtonStyle}
          />
        </Tooltip>
      </div>
    </Tag>
  );
}
