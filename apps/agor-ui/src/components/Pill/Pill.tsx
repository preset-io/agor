import type { ContextUsageSnapshot } from '@agor/core/types';
import type { SessionStatus, TaskStatus } from '@agor-live/client';
import { shortId } from '@agor-live/client';
// TODO: Move normalization to DB or daemon API
import {
  ApartmentOutlined,
  BranchesOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  CodeOutlined,
  CopyOutlined,
  EditOutlined,
  FileTextOutlined,
  ForkOutlined,
  GithubOutlined,
  IdcardOutlined,
  LinkOutlined,
  MessageOutlined,
  PercentageOutlined,
  RobotOutlined,
  SlackOutlined,
  ThunderboltOutlined,
  ToolOutlined,
  UnorderedListOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Badge, Collapse, Popover, Tooltip, theme } from 'antd';
import type React from 'react';
import { copyToClipboard } from '../../utils/clipboard';
import { resolveContextWindowPercentage } from '../../utils/contextWindow';
import { parseGitStateSha } from '../../utils/gitState';
import { type SessionForIds, SessionIdsList } from '../SessionIds';
import { Tag } from '../Tag';
import { getModelDisplayName } from './modelDisplay';
import { getUrlDisplayLabel, isGitHubUrl, type UrlDisplayRepo } from './url-helpers';

/**
 * Object/entity colors for clickable identity pills.
 *
 * Keep these distinct from status colors below: object colors answer
 * "what kind of thing is this?", while status colors answer "what state is it in?".
 * Values are Ant Design preset colors.
 */
export const ENTITY_PILL_COLORS = {
  branch: 'cyan',
  session: 'default',
  board: 'blue',
  teammate: 'geekblue',
  mcp: 'purple',
  user: 'orange',
  artifact: 'gold',
  repo: 'default',
} as const;

/**
 * Standardized color palette for pills/badges.
 * Using subset of Ant Design preset colors for consistency.
 */
export const PILL_COLORS = {
  // Metadata (grayscale - subtle, informational only)
  message: 'default', // Message counts
  tool: 'default', // Tool usage
  token: 'default', // Token usage
  model: 'default', // Model ID
  git: 'default', // Git info (clean state)
  session: ENTITY_PILL_COLORS.session, // Session IDs

  // Status (colored - actionable/warnings)
  success: 'green', // Completed/success
  error: 'red', // Failed/error
  warning: 'orange', // Dirty state, warnings
  processing: 'cyan', // Running/in-progress

  // Genealogy
  fork: 'cyan', // Forked sessions
  spawn: 'purple', // Spawned sessions

  // Features
  report: 'green', // Has report
  concept: 'geekblue', // Loaded concepts
  branch: ENTITY_PILL_COLORS.branch, // Managed branch
} as const;

interface BasePillProps {
  size?: 'small' | 'default';
  style?: React.CSSProperties;
}

/**
 * Base Pill component - standardized Tag wrapper with consistent styling
 *
 * Provides:
 * - Monospace font (token.fontFamilyCode) for content
 * - Consistent icon sizing (12px)
 * - Standard Tag dimensions (22px height, 7px padding)
 * - Consistent line-height for vertical alignment
 *
 * DO NOT accept style prop - all styling is standardized internally
 */
interface PillProps {
  icon?: React.ReactNode;
  color?: string;
  children: React.ReactNode;
  onClick?: (e: EntityPillInteractionEvent) => void;
  tooltip?: string;
}

export const Pill: React.FC<PillProps> = ({
  icon,
  color = 'default',
  children,
  onClick,
  tooltip,
}) => {
  const { token } = theme.useToken();

  const tag = (
    <Tag
      icon={icon}
      color={color}
      style={{
        cursor: onClick ? 'pointer' : 'default',
      }}
      onClick={onClick}
    >
      <span style={{ fontFamily: token.fontFamilyCode, lineHeight: 1 }}>{children}</span>
    </Tag>
  );

  return tooltip ? <span title={tooltip}>{tag}</span> : tag;
};

interface MessageCountPillProps extends BasePillProps {
  count: number;
}

export const MessageCountPill: React.FC<MessageCountPillProps> = ({ count, style }) => (
  <Tag icon={<MessageOutlined />} color={PILL_COLORS.message} style={style}>
    <span>{count}</span>
  </Tag>
);

interface ToolCountPillProps extends BasePillProps {
  count: number;
  toolName?: string;
}

export const ToolCountPill: React.FC<ToolCountPillProps> = ({ count, toolName, style }) => (
  <Tag icon={<ToolOutlined />} color={PILL_COLORS.tool} style={style}>
    {count}
  </Tag>
);

interface TokenCountPillProps extends BasePillProps {
  count: number;
  estimatedCost?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export const TokenCountPill: React.FC<TokenCountPillProps> = ({
  count,
  estimatedCost,
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheCreationTokens,
  style,
}) => {
  // Build detailed tooltip if breakdown is available
  const hasBreakdown = inputTokens !== undefined || outputTokens !== undefined;
  const tooltipContent = hasBreakdown ? (
    <div>
      {inputTokens !== undefined && <div>Input: {inputTokens.toLocaleString()}</div>}
      {outputTokens !== undefined && <div>Output: {outputTokens.toLocaleString()}</div>}
      {cacheReadTokens !== undefined && cacheReadTokens > 0 && (
        <div>Cache Read: {cacheReadTokens.toLocaleString()}</div>
      )}
      {cacheCreationTokens !== undefined && cacheCreationTokens > 0 && (
        <div>Cache Creation: {cacheCreationTokens.toLocaleString()}</div>
      )}
      {estimatedCost !== undefined && <div>Est. Cost: ${estimatedCost.toFixed(4)}</div>}
    </div>
  ) : estimatedCost !== undefined ? (
    `Est. Cost: $${estimatedCost.toFixed(4)}`
  ) : undefined;

  const pill = (
    <Tag icon={<ThunderboltOutlined />} color={PILL_COLORS.token} style={style}>
      {count.toLocaleString()}
    </Tag>
  );

  return tooltipContent ? <Tooltip title={tooltipContent}>{pill}</Tooltip> : pill;
};

interface ContextWindowPillProps extends BasePillProps {
  used: number;
  limit: number;
  // Optional: Full task metadata for detailed tooltip
  taskMetadata?: {
    model?: string;
    duration_ms?: number;
    // Agentic tool name (needed to normalize SDK response)
    agentic_tool?: string;
    // Raw SDK response - single source of truth for token accounting
    raw_sdk_response?: unknown;
    // Normalized SDK response - pre-computed by executor
    normalized_sdk_response?: {
      tokenUsage: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
      };
      contextWindowLimit?: number;
      costUsd?: number;
      primaryModel?: string;
      durationMs?: number;
      contextUsageSnapshot?: ContextUsageSnapshot;
    };
  };
}

/**
 * Context Window Popover Content Component
 * Displays detailed token usage, breakdown, and metadata in a structured layout
 */
const ContextWindowPopoverContent: React.FC<{
  used: number;
  limit: number;
  percentage: number;
  taskMetadata?: ContextWindowPillProps['taskMetadata'];
}> = ({ used, limit, percentage, taskMetadata }) => {
  const { token } = theme.useToken();

  // Build collapsible items for advanced sections
  const advancedItems = [];

  // Get SDK response from task metadata
  const sdkResponse = taskMetadata?.raw_sdk_response;
  // Get normalized SDK response (pre-computed by executor)
  const normalized = taskMetadata?.normalized_sdk_response;

  // Add authoritative context usage from SDK's getContextUsage() if available
  const contextUsageSnapshot = normalized?.contextUsageSnapshot ?? null;

  if (contextUsageSnapshot) {
    advancedItems.push({
      key: 'sdk-context-usage',
      label: 'Context Window (SDK)',
      children: (
        <div style={{ fontSize: '0.9em', color: token.colorTextSecondary }}>
          <div>
            Used: <strong>{contextUsageSnapshot.totalTokens.toLocaleString()}</strong> tokens
          </div>
          <div>
            Limit: <strong>{contextUsageSnapshot.maxTokens.toLocaleString()}</strong> tokens
          </div>
          <div>
            Percentage: <strong>{contextUsageSnapshot.percentage}%</strong>
          </div>
          <div style={{ fontSize: '0.85em', color: token.colorTextTertiary, marginTop: 4 }}>
            Authoritative snapshot reported by the agent (Claude SDK getContextUsage() or Codex CLI
            token_count event).
          </div>
        </div>
      ),
    });
  }

  // Add per-model usage if available (Claude Code multi-model)
  // Check for modelUsage field (only Claude SDK has this)
  if (
    sdkResponse &&
    typeof sdkResponse === 'object' &&
    sdkResponse !== null &&
    'modelUsage' in sdkResponse &&
    sdkResponse.modelUsage
  ) {
    advancedItems.push({
      key: 'per-model',
      label: 'Per-Model Usage',
      children: (
        <div style={{ fontSize: '0.9em' }}>
          {Object.entries(sdkResponse.modelUsage).map(([modelId, usage]) => {
            const _modelContextUsage = (usage.inputTokens || 0) + (usage.outputTokens || 0);

            return (
              <div key={modelId} style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>{modelId}</div>
                <div
                  style={{ marginLeft: 12, fontSize: '0.95em', color: token.colorTextSecondary }}
                >
                  <div>Input: {usage.inputTokens?.toLocaleString() || 0}</div>
                  <div>Output: {usage.outputTokens?.toLocaleString() || 0}</div>
                  {usage.cacheCreationInputTokens !== undefined &&
                    usage.cacheCreationInputTokens > 0 && (
                      <div>Cache creation: {usage.cacheCreationInputTokens.toLocaleString()}</div>
                    )}
                  {usage.cacheReadInputTokens !== undefined && usage.cacheReadInputTokens > 0 && (
                    <div>Cache read: {usage.cacheReadInputTokens.toLocaleString()}</div>
                  )}
                  <div style={{ marginTop: 4, fontWeight: 500, color: token.colorText }}>
                    Context limit: {usage.contextWindow?.toLocaleString() || 0}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ),
    });
  }

  // Add raw SDK response as collapsible (exact, unaltered response)
  if (sdkResponse) {
    advancedItems.push({
      key: 'raw-sdk-response',
      label: '🔍 Raw SDK Response',
      children: (
        <pre
          style={{
            fontSize: '0.75em',
            fontFamily: token.fontFamilyCode,
            background: token.colorBgContainer,
            padding: 8,
            borderRadius: 4,
            overflowX: 'auto',
            maxHeight: 300,
            margin: 0,
            border: `1px solid ${token.colorBorder}`,
          }}
        >
          {JSON.stringify(sdkResponse, null, 2)}
        </pre>
      ),
    });
  }

  return (
    <div style={{ width: 400, maxWidth: '90vw' }}>
      {/* Primary info - always visible */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, fontSize: '1.05em', marginBottom: 8 }}>
          Context Window Usage
        </div>
        <div style={{ fontSize: '1.1em', fontFamily: token.fontFamilyCode }}>
          {used.toLocaleString()}
          {limit > 0 ? ` / ${limit.toLocaleString()}` : ''}{' '}
          {limit > 0 && <span style={{ color: token.colorTextSecondary }}>({percentage}%)</span>}
        </div>
        <div style={{ fontSize: '0.85em', color: token.colorTextTertiary, marginTop: 6 }}>
          {limit > 0
            ? 'Current context window snapshot'
            : 'Current context window snapshot (limit unknown)'}
        </div>
      </div>

      {/* Token breakdown - normalized from SDK response */}
      {normalized && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 500, marginBottom: 6 }}>Token Breakdown</div>
          <div style={{ fontSize: '0.9em', marginLeft: 12, color: token.colorTextSecondary }}>
            <div>Input: {normalized.tokenUsage.inputTokens.toLocaleString()}</div>
            <div>Output: {normalized.tokenUsage.outputTokens.toLocaleString()}</div>
            {(normalized.tokenUsage.cacheCreationTokens ?? 0) > 0 && (
              <div>
                Cache creation: {normalized.tokenUsage.cacheCreationTokens?.toLocaleString()}
              </div>
            )}
            {(normalized.tokenUsage.cacheReadTokens ?? 0) > 0 && (
              <div>Cache read: {normalized.tokenUsage.cacheReadTokens?.toLocaleString()}</div>
            )}
            <div style={{ marginTop: 4, fontWeight: 500, color: token.colorText }}>
              Total: {normalized.tokenUsage.totalTokens.toLocaleString()}
            </div>
          </div>
        </div>
      )}

      {/* Model & duration - compact */}
      {(taskMetadata?.model || taskMetadata?.duration_ms !== undefined) && (
        <div
          style={{
            fontSize: '0.85em',
            color: token.colorTextSecondary,
            paddingTop: 12,
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            marginBottom: 16,
          }}
        >
          {taskMetadata?.model && (
            <div>
              Model: <span style={{ fontFamily: token.fontFamilyCode }}>{taskMetadata.model}</span>
            </div>
          )}
          {taskMetadata?.duration_ms !== undefined && (
            <div>Duration: {(taskMetadata.duration_ms / 1000).toFixed(2)}s</div>
          )}
        </div>
      )}

      {/* Advanced sections - collapsible */}
      {advancedItems.length > 0 && (
        <Collapse
          size="small"
          ghost
          items={advancedItems}
          style={{
            fontSize: '0.9em',
          }}
        />
      )}
    </div>
  );
};

export const ContextWindowPill: React.FC<ContextWindowPillProps> = ({
  used,
  limit,
  taskMetadata,
  style,
}) => {
  // Prefer the executor-supplied snapshot — its totalTokens/maxTokens are
  // authoritative (agent-reported), and its `percentage` matches the agent's
  // own "Context XX% used" display (e.g. Codex applies a baseline subtraction
  // that does NOT equal raw `used / limit`). Fall back to the explicit
  // used/limit props when no snapshot is available.
  const snapshot = taskMetadata?.normalized_sdk_response?.contextUsageSnapshot;
  const effectiveUsed = snapshot?.totalTokens ?? used;
  const effectiveLimit = snapshot?.maxTokens ?? limit;
  const hasLimit = effectiveLimit > 0;
  const percentage = hasLimit
    ? Math.round(resolveContextWindowPercentage(effectiveUsed, effectiveLimit, snapshot))
    : 0;

  // Color-code based on usage: green (<50%), yellow (50-80%), red (>80%)
  const getColor = () => {
    if (!hasLimit) return 'blue'; // Blue for unknown limit
    if (percentage < 50) return 'green';
    if (percentage < 80) return 'orange';
    return 'red';
  };

  const pill = (
    <Tag icon={<PercentageOutlined />} color={getColor()} style={style}>
      {hasLimit ? `${percentage}%` : '?'}
    </Tag>
  );

  return (
    <Popover
      content={
        <ContextWindowPopoverContent
          used={effectiveUsed}
          limit={effectiveLimit}
          percentage={percentage}
          taskMetadata={taskMetadata}
        />
      }
      title={null}
      trigger="hover"
      placement="top"
      mouseEnterDelay={0.3}
    >
      {pill}
    </Popover>
  );
};

interface ModelPillProps extends BasePillProps {
  model: string;
}

export const ModelPill: React.FC<ModelPillProps> = ({ model, style }) => {
  return (
    <Tag icon={<RobotOutlined />} color={PILL_COLORS.model} style={style}>
      {getModelDisplayName(model)}
    </Tag>
  );
};

/**
 * Small amber dot indicating uncommitted ("dirty") working tree changes.
 * Mirrors the VSCode unsaved-file affordance. Rendered inline at the end of
 * a git-SHA pill (purely decorative — the parent pill carries the tooltip
 * that explains both the SHA and the dot, so the dot is `aria-hidden`).
 */
const DirtyDot: React.FC = () => (
  <span aria-hidden="true" style={{ display: 'inline-flex', flexShrink: 0, marginLeft: 6 }}>
    <Badge status="warning" />
  </span>
);

interface GitShaPillProps extends BasePillProps {
  sha: string;
  isDirty?: boolean;
  showDirtyIndicator?: boolean;
}

export const GitShaPill: React.FC<GitShaPillProps> = ({
  sha,
  isDirty = false,
  showDirtyIndicator = true,
  style,
}) => {
  const { token } = theme.useToken();
  const { cleanSha } = parseGitStateSha(sha);
  const displaySha = cleanSha.substring(0, 7);
  const showDirty = isDirty && showDirtyIndicator;
  const tooltip = showDirty
    ? 'Git commit SHA (working tree has uncommitted changes) · click to copy'
    : 'Git commit SHA · click to copy';

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await copyToClipboard(cleanSha);
  };

  return (
    <Tooltip title={tooltip}>
      <Tag
        icon={<GithubOutlined />}
        color={PILL_COLORS.git}
        style={{ ...style, cursor: 'pointer' }}
        onClick={handleClick}
      >
        <span style={{ fontFamily: token.fontFamilyCode }}>{displaySha}</span>
        {showDirty && <DirtyDot />}
      </Tag>
    </Tooltip>
  );
};

interface GitStatePillProps extends BasePillProps {
  branch?: string; // Branch name (renamed from 'ref' to avoid React reserved word)
  sha: string;
  branchName?: string; // Hide branch name if it matches branch name
  showDirtyIndicator?: boolean;
}

export const GitStatePill: React.FC<GitStatePillProps> = ({
  branch,
  sha,
  branchName,
  showDirtyIndicator = true,
  style,
}) => {
  const { token } = theme.useToken();
  const { cleanSha, isDirty } = parseGitStateSha(sha);
  const displaySha = cleanSha.substring(0, 7);
  const showDirty = isDirty && showDirtyIndicator;

  // Only show branch if it differs from branch name
  const shouldShowBranch = branch && branch !== branchName;

  const tooltip = showDirty
    ? 'Git commit SHA (working tree has uncommitted changes) · click to copy'
    : 'Git commit SHA · click to copy';

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await copyToClipboard(cleanSha);
  };

  return (
    <Tooltip title={tooltip}>
      <Tag
        icon={<ForkOutlined />}
        color={PILL_COLORS.git}
        style={{ ...style, cursor: 'pointer' }}
        onClick={handleClick}
      >
        {shouldShowBranch && <span>{branch} : </span>}
        <span style={{ fontFamily: token.fontFamilyCode }}>{displaySha}</span>
        {showDirty && <DirtyDot />}
      </Tag>
    </Tooltip>
  );
};

interface SessionIdPillProps extends BasePillProps {
  sessionId: string;
  sdkSessionId?: string; // SDK session ID (Claude Agent SDK, Codex thread, etc.)
  agenticTool?: string; // Agentic tool name (claude-code, codex, gemini) for tooltip
  showCopy?: boolean;
}

export const SessionIdPill: React.FC<SessionIdPillProps> = ({
  sessionId,
  sdkSessionId,
  agenticTool,
  showCopy = true,
  size = 'small',
  style,
}) => {
  const { token } = theme.useToken();
  // Prefer SDK session ID (more useful for CLI/logs) over Agor internal ID
  const displayId = sdkSessionId || sessionId;
  const idShort = shortId(displayId);

  const pill = (
    <Tag
      icon={showCopy ? <CopyOutlined /> : <CodeOutlined />}
      color={PILL_COLORS.session}
      style={{ cursor: showCopy ? 'pointer' : 'default', ...style }}
    >
      <span style={{ fontFamily: token.fontFamilyCode }}>{idShort}</span>
    </Tag>
  );

  if (!showCopy) {
    return pill;
  }

  return (
    <Popover
      title={
        <span>
          <IdcardOutlined style={{ marginRight: 8 }} />
          Session IDs
        </span>
      }
      content={
        <div style={{ width: 400, maxWidth: '90vw' }}>
          <SessionIdsList
            session={
              {
                session_id: sessionId,
                sdk_session_id: sdkSessionId,
                agentic_tool: agenticTool,
              } as SessionForIds
            }
          />
        </div>
      }
      trigger="hover"
      placement="top"
      mouseEnterDelay={0.3}
    >
      {pill}
    </Popover>
  );
};

interface StatusPillProps extends BasePillProps {
  status:
    | (typeof TaskStatus)[keyof typeof TaskStatus]
    | (typeof SessionStatus)[keyof typeof SessionStatus]
    | 'pending';
}

export const StatusPill: React.FC<StatusPillProps> = ({ status, style }) => {
  // Both TaskStatus and SessionStatus share the same values (completed, failed, running)
  // So we can use a single config object without duplicates
  const config: Record<string, { icon: React.ReactElement; color: string; text: string }> = {
    completed: {
      icon: <CheckCircleOutlined />,
      color: PILL_COLORS.success,
      text: 'Completed',
    },
    failed: {
      icon: <CloseCircleOutlined />,
      color: PILL_COLORS.error,
      text: 'Failed',
    },
    running: {
      icon: <ToolOutlined />,
      color: PILL_COLORS.processing,
      text: 'Running',
    },
    timed_out: {
      icon: <ClockCircleOutlined />,
      color: PILL_COLORS.warning,
      text: 'Timed Out',
    },
    idle: {
      icon: <ToolOutlined />,
      color: PILL_COLORS.session,
      text: 'Idle',
    },
    pending: { icon: <ToolOutlined />, color: PILL_COLORS.session, text: 'Pending' },
  };

  const statusConfig = config[status];
  if (!statusConfig) {
    // Fallback for unknown status
    return (
      <Tag icon={<ToolOutlined />} color={PILL_COLORS.session} style={style}>
        {status}
      </Tag>
    );
  }

  return (
    <Tag icon={statusConfig.icon} color={statusConfig.color} style={style}>
      {statusConfig.text}
    </Tag>
  );
};

interface ForkPillProps extends BasePillProps {
  fromSessionId: string;
  taskId?: string;
  messageIndex?: number;
}

export const ForkPill: React.FC<ForkPillProps> = ({
  fromSessionId,
  taskId,
  messageIndex,
  style,
}) => {
  const handleCopySessionId = (e: React.MouseEvent) => {
    e.stopPropagation();
    copyToClipboard(fromSessionId);
  };

  return (
    <Tooltip
      title={
        <div>
          <div>Forked from session {shortId(fromSessionId)}</div>
          {messageIndex !== undefined && <div>Message index: {messageIndex}</div>}
          <div style={{ marginTop: 4, fontSize: '0.9em', opacity: 0.8 }}>
            Click to copy session ID
          </div>
        </div>
      }
    >
      <Tag
        icon={<ForkOutlined />}
        color={PILL_COLORS.fork}
        style={{ ...style, cursor: 'pointer' }}
        onClick={handleCopySessionId}
      >
        FORKED from {shortId(fromSessionId)}
        {messageIndex !== undefined && ` as of message ${messageIndex}`}
      </Tag>
    </Tooltip>
  );
};

interface SpawnPillProps extends BasePillProps {
  fromSessionId: string;
  taskId?: string;
  messageIndex?: number;
}

export const SpawnPill: React.FC<SpawnPillProps> = ({
  fromSessionId,
  taskId,
  messageIndex,
  style,
}) => {
  const handleCopySessionId = (e: React.MouseEvent) => {
    e.stopPropagation();
    copyToClipboard(fromSessionId);
  };

  return (
    <Tooltip
      title={
        <div>
          <div>Spawned from session {shortId(fromSessionId)}</div>
          {messageIndex !== undefined && <div>Message index: {messageIndex}</div>}
          <div style={{ marginTop: 4, fontSize: '0.9em', opacity: 0.8 }}>
            Click to copy session ID
          </div>
        </div>
      }
    >
      <Tag
        icon={<BranchesOutlined />}
        color={PILL_COLORS.spawn}
        style={{ ...style, cursor: 'pointer' }}
        onClick={handleCopySessionId}
      >
        SPAWNED from {shortId(fromSessionId)}
        {messageIndex !== undefined && ` as of message ${messageIndex}`}
      </Tag>
    </Tooltip>
  );
};

interface ReportPillProps extends BasePillProps {
  reportId?: string;
}

export const ReportPill: React.FC<ReportPillProps> = ({ reportId, style }) => (
  <Tag icon={<FileTextOutlined />} color={PILL_COLORS.report} style={style}>
    {/* shortid-guard:ignore reportId is a `<session>/<task>.md` file path, not a UUIDv7 */}
    {reportId ? `Report ${reportId.substring(0, 7)}` : 'Has Report'}
  </Tag>
);

interface ConceptPillProps extends BasePillProps {
  name: string;
}

export const ConceptPill: React.FC<ConceptPillProps> = ({ name, style }) => (
  <Tag color={PILL_COLORS.concept} style={style}>
    📦 {name}
  </Tag>
);

interface DirtyStatePillProps extends BasePillProps {}

export const DirtyStatePill: React.FC<DirtyStatePillProps> = ({ style }) => {
  const { token } = theme.useToken();

  return (
    <Tag icon={<EditOutlined />} color={PILL_COLORS.warning} style={style}>
      <span style={{ fontFamily: token.fontFamilyCode }}>uncommitted changes</span>
    </Tag>
  );
};

type EntityPillInteractionEvent =
  | React.MouseEvent<HTMLSpanElement>
  | React.KeyboardEvent<HTMLSpanElement>;

interface EntityPillProps extends BasePillProps {
  icon?: React.ReactNode;
  color: string;
  label?: React.ReactNode;
  emoji?: string | null;
  compact?: boolean;
  title?: string;
  onClick?: (e: EntityPillInteractionEvent) => void;
  maxWidth?: number;
  code?: boolean;
  ariaLabel?: string;
  'aria-label'?: string;
}

export const EntityPill: React.FC<EntityPillProps> = ({
  icon,
  color,
  label,
  emoji,
  compact = false,
  title,
  onClick,
  maxWidth = 220,
  code = false,
  ariaLabel,
  'aria-label': ariaLabelProp,
  style,
}) => {
  const { token } = theme.useToken();
  const hasLabel = label !== undefined && label !== null && label !== '';
  const interactive = Boolean(onClick);
  const resolvedAriaLabel = ariaLabelProp ?? ariaLabel;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLSpanElement>) => {
    if (!onClick || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    onClick(event);
  };

  return (
    <Tag
      icon={emoji ? undefined : icon}
      color={color}
      title={title}
      aria-label={resolvedAriaLabel}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={handleKeyDown}
      style={{
        maxWidth: compact ? '100%' : undefined,
        marginInlineEnd: compact ? 0 : undefined,
        cursor: interactive ? 'pointer' : 'default',
        ...style,
      }}
      onClick={onClick}
    >
      {hasLabel && (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: emoji ? 4 : undefined,
            maxWidth: compact ? maxWidth : undefined,
            overflow: compact ? 'hidden' : undefined,
            textOverflow: compact ? 'ellipsis' : undefined,
            whiteSpace: compact ? 'nowrap' : undefined,
            verticalAlign: compact ? 'bottom' : undefined,
            fontFamily: code ? token.fontFamilyCode : token.fontFamily,
          }}
        >
          {emoji && <span style={{ fontFamily: token.fontFamily }}>{emoji}</span>}
          {label}
        </span>
      )}
    </Tag>
  );
};

interface BranchPillProps extends BasePillProps {
  branch: string;
  compact?: boolean;
  title?: string;
  emoji?: string | null;
  onClick?: (e: EntityPillInteractionEvent) => void;
}

export const BranchPill: React.FC<BranchPillProps> = ({
  branch,
  compact = false,
  title,
  emoji,
  onClick,
  style,
}) => (
  <EntityPill
    icon={<BranchesOutlined />}
    color={ENTITY_PILL_COLORS.branch}
    label={branch}
    emoji={emoji}
    compact={compact}
    title={title}
    onClick={onClick}
    code
    style={style}
  />
);

interface BoardPillProps extends BasePillProps {
  board: {
    name: string;
    icon?: string | null;
  };
  compact?: boolean;
  title?: string;
  onClick?: (e: EntityPillInteractionEvent) => void;
}

export const BoardPill: React.FC<BoardPillProps> = ({
  board,
  compact = false,
  title,
  onClick,
  style,
}) => (
  <EntityPill
    icon={<ApartmentOutlined />}
    color={ENTITY_PILL_COLORS.board}
    label={board.name}
    emoji={board.icon}
    compact={compact}
    title={title ?? board.name}
    onClick={onClick}
    style={style}
  />
);

interface UserPillProps extends BasePillProps {
  user: {
    name?: string | null;
    email?: string | null;
    emoji?: string | null;
  };
  compact?: boolean;
  title?: string;
  onClick?: (e: EntityPillInteractionEvent) => void;
}

export const UserPill: React.FC<UserPillProps> = ({
  user,
  compact = false,
  title,
  onClick,
  style,
}) => {
  const label = user.name || user.email || 'Someone';

  return (
    <EntityPill
      icon={<UserOutlined />}
      color={ENTITY_PILL_COLORS.user}
      label={label}
      emoji={user.emoji}
      compact={compact}
      title={title ?? label}
      onClick={onClick}
      maxWidth={180}
      style={style}
    />
  );
};

interface TeammatePillProps extends BasePillProps {
  name: string;
  emoji?: string | null;
  compact?: boolean;
  title?: string;
  onClick?: (e: EntityPillInteractionEvent) => void;
}

export const TeammatePill: React.FC<TeammatePillProps> = ({
  name,
  emoji,
  compact = false,
  title,
  onClick,
  style,
}) => (
  <EntityPill
    icon={<RobotOutlined />}
    color={ENTITY_PILL_COLORS.teammate}
    label={name}
    emoji={emoji}
    compact={compact}
    title={title ?? name}
    onClick={onClick}
    code
    style={style}
  />
);

/** @deprecated Use TeammatePill instead. */

interface SessionPillProps extends BasePillProps {
  label?: React.ReactNode;
  compact?: boolean;
  title?: string;
  ariaLabel?: string;
  'aria-label'?: string;
  onClick?: (e: EntityPillInteractionEvent) => void;
}

export const SessionPill: React.FC<SessionPillProps> = ({
  label,
  compact = false,
  title,
  ariaLabel,
  'aria-label': ariaLabelProp,
  onClick,
  style,
}) => (
  <EntityPill
    icon={<UnorderedListOutlined />}
    color={ENTITY_PILL_COLORS.session}
    label={label}
    compact={compact}
    title={title}
    ariaLabel={ariaLabelProp ?? ariaLabel}
    onClick={onClick}
    style={style}
  />
);

interface KnowledgeNamespacePillProps extends BasePillProps {
  namespace: string;
}

export const KnowledgeNamespacePill: React.FC<KnowledgeNamespacePillProps> = ({
  namespace,
  style,
}) => <EntityPill color="default" label={namespace} compact title={namespace} style={style} />;

interface RepoPillProps extends BasePillProps {
  repoName: string;
  branchName?: string;
  onClick?: () => void;
  /** Tag color. Defaults to 'cyan'; pass 'default' for a muted theme-neutral tag. */
  color?: string;
}

export const RepoPill: React.FC<RepoPillProps> = ({
  repoName,
  branchName,
  onClick,
  color = 'cyan',
  size,
  style,
}) => {
  const { token } = theme.useToken();

  return (
    <Tag
      icon={<BranchesOutlined />}
      color={color}
      style={{ ...style, cursor: onClick ? 'pointer' : 'default' }}
      onClick={onClick}
    >
      <span style={{ fontFamily: token.fontFamilyCode }}>
        {repoName}
        {branchName && (
          <>
            {' '}
            <ApartmentOutlined style={{ fontSize: '0.85em', opacity: 0.7 }} /> {branchName}
          </>
        )}
      </span>
    </Tag>
  );
};

export { getUrlDisplayLabel, isGitHubUrl } from './url-helpers';

function getIssueIcon(url: string): React.ReactNode {
  if (isGitHubUrl(url)) return <GithubOutlined />;
  return <LinkOutlined />;
}

function getPrIcon(url: string): React.ReactNode {
  if (isGitHubUrl(url)) return <GithubOutlined />;
  return <BranchesOutlined />;
}

const pillTextStyle: React.CSSProperties = {
  maxWidth: 160,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  display: 'inline-block',
  verticalAlign: 'middle',
};

interface IssuePillProps extends BasePillProps {
  issueUrl: string;
  issueNumber?: string;
  currentRepo?: UrlDisplayRepo;
}

export const IssuePill: React.FC<IssuePillProps> = ({
  issueUrl,
  issueNumber,
  currentRepo,
  style,
}) => {
  const displayText = issueNumber || getUrlDisplayLabel(issueUrl, { currentRepo });

  return (
    <Tooltip title={issueUrl}>
      <Tag
        icon={getIssueIcon(issueUrl)}
        color={PILL_COLORS.git}
        style={{ ...style, cursor: 'pointer', maxWidth: 220 }}
        onClick={() => window.open(issueUrl, '_blank')}
      >
        <span style={pillTextStyle}>Issue: {displayText}</span>
      </Tag>
    </Tooltip>
  );
};

interface PullRequestPillProps extends BasePillProps {
  prUrl: string;
  prNumber?: string;
  currentRepo?: UrlDisplayRepo;
}

export const PullRequestPill: React.FC<PullRequestPillProps> = ({
  prUrl,
  prNumber,
  currentRepo,
  style,
}) => {
  const displayText = prNumber || getUrlDisplayLabel(prUrl, { currentRepo });

  return (
    <Tooltip title={prUrl}>
      <Tag
        icon={getPrIcon(prUrl)}
        color={PILL_COLORS.git}
        style={{ ...style, cursor: 'pointer', maxWidth: 220 }}
        onClick={() => window.open(prUrl, '_blank')}
      >
        <span style={pillTextStyle}>PR: {displayText}</span>
      </Tag>
    </Tooltip>
  );
};

interface ScheduledRunPillProps extends BasePillProps {
  scheduledRunAt: number;
}

export const ScheduledRunPill: React.FC<ScheduledRunPillProps> = ({ scheduledRunAt, style }) => {
  // Format timestamp for display
  const runDate = new Date(scheduledRunAt);
  const displayTime = runDate.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  // Build detailed tooltip
  const tooltip = `Scheduled run at ${runDate.toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  })}\nRun ID: ${scheduledRunAt}`;

  return (
    <Pill icon={<ClockCircleOutlined />} color={PILL_COLORS.processing} tooltip={tooltip}>
      {displayTime}
    </Pill>
  );
};

interface ChannelPillProps extends BasePillProps {
  channelType: string; // e.g., "slack", "discord"
  channelName: string;
}

export const ChannelPill: React.FC<ChannelPillProps> = ({ channelType, channelName, style }) => {
  // Map channel type to icon
  const getIcon = () => {
    const type = (channelType || '').toLowerCase();
    switch (type) {
      case 'slack':
        return <SlackOutlined />;
      case 'discord':
        return <MessageOutlined />; // TODO: Add DiscordOutlined when available
      default:
        return <MessageOutlined />;
    }
  };

  return (
    <Tag icon={getIcon()} color={PILL_COLORS.success} style={style}>
      {channelName}
    </Tag>
  );
};
