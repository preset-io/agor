import type { SessionStatus, TaskStatus } from '@agor/core/types';
// TODO: Move normalization to DB or daemon API
// import { normalizeRawSdkResponse } from '@agor/core/utils/sdk-normalizer';
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
  MessageOutlined,
  PercentageOutlined,
  RobotOutlined,
  ThunderboltOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { Collapse, Popover, Tooltip, theme } from 'antd';
import type React from 'react';
import { copyToClipboard } from '../../utils/clipboard';
import { Tag } from '../Tag';

/**
 * Standardized color palette for pills/badges
 * Using subset of Ant Design preset colors for consistency
 */
export const PILL_COLORS = {
  // Metadata (grayscale - subtle, informational only)
  message: 'default', // Message counts
  tool: 'default', // Tool usage
  token: 'default', // Token usage
  model: 'default', // Model ID
  git: 'default', // Git info (clean state)
  session: 'default', // Session IDs

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
  worktree: 'blue', // Managed worktree
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
  onClick?: (e: React.MouseEvent) => void;
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
            ? 'Cumulative conversation tokens'
            : 'Cumulative conversation tokens (limit unknown)'}
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
  // Handle division by zero - if no limit, show as unknown percentage
  const percentage = limit > 0 ? Math.round((used / limit) * 100) : 0;
  const hasLimit = limit > 0;

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
          used={used}
          limit={limit}
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
  // Simplify model name for display
  // Examples:
  // - "claude-sonnet-4-5-20250929" -> "sonnet-4.5"
  // - "gpt-4o" -> "gpt-4o"
  // - "gpt-3.5-turbo" -> "gpt-3.5-turbo"
  const getDisplayName = (modelId: string) => {
    // Claude models: extract version from pattern
    if (modelId.includes('sonnet')) {
      const match = modelId.match(/sonnet-(\d)-(\d)/);
      return match ? `sonnet-${match[1]}.${match[2]}` : 'sonnet';
    }
    if (modelId.includes('haiku')) {
      const match = modelId.match(/haiku-(\d)-(\d)/);
      return match ? `haiku-${match[1]}.${match[2]}` : 'haiku';
    }
    if (modelId.includes('opus')) {
      const match = modelId.match(/opus-(\d)-(\d)/);
      return match ? `opus-${match[1]}.${match[2]}` : 'opus';
    }

    // OpenAI GPT models: show as-is (e.g., "gpt-4o", "gpt-3.5-turbo", "gpt-4-turbo")
    if (modelId.startsWith('gpt-')) {
      return modelId;
    }

    // Gemini models: show as-is (e.g., "gemini-2.5-flash", "gemini-2.5-pro")
    if (modelId.startsWith('gemini-')) {
      return modelId;
    }

    // Fallback to full ID for unknown models
    return modelId;
  };

  return (
    <Tag icon={<RobotOutlined />} color={PILL_COLORS.model} style={style}>
      {getDisplayName(model)}
    </Tag>
  );
};

interface GitShaPillProps extends BasePillProps {
  sha: string;
  isDirty?: boolean;
  showDirtyIndicator?: boolean;
}

export const GitShaPill: React.FC<GitShaPillProps> = ({
  sha,
  isDirty = false,
  showDirtyIndicator = true,
  size,
  style,
}) => {
  const { token } = theme.useToken();
  const cleanSha = sha.replace('-dirty', '');
  const displaySha = cleanSha.substring(0, 7);

  return (
    <Tag
      icon={<GithubOutlined />}
      color={isDirty && showDirtyIndicator ? PILL_COLORS.warning : PILL_COLORS.git}
      style={style}
    >
      <span style={{ fontFamily: token.fontFamilyCode }}>{displaySha}</span>
      {isDirty && showDirtyIndicator && ' (dirty)'}
    </Tag>
  );
};

interface GitStatePillProps extends BasePillProps {
  branch?: string; // Branch name (renamed from 'ref' to avoid React reserved word)
  sha: string;
  worktreeName?: string; // Hide branch name if it matches worktree name
  showDirtyIndicator?: boolean;
}

export const GitStatePill: React.FC<GitStatePillProps> = ({
  branch,
  sha,
  worktreeName,
  showDirtyIndicator = true,
  style,
}) => {
  const { token } = theme.useToken();
  const isDirty = sha.endsWith('-dirty');
  const cleanSha = sha.replace('-dirty', '');
  const displaySha = cleanSha.substring(0, 7);

  // Only show branch if it differs from worktree name
  const shouldShowBranch = branch && branch !== worktreeName;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    copyToClipboard(cleanSha, {
      showSuccess: true,
      successMessage: 'Git SHA copied to clipboard',
    });
  };

  return (
    <Tooltip title="Click to copy full SHA">
      <Tag
        icon={<ForkOutlined />}
        color={isDirty && showDirtyIndicator ? 'cyan' : PILL_COLORS.git}
        style={{ ...style, cursor: 'pointer' }}
        onClick={handleClick}
      >
        {shouldShowBranch && <span>{branch} : </span>}
        <span style={{ fontFamily: token.fontFamilyCode }}>{displaySha}</span>
        {isDirty && showDirtyIndicator && ' (dirty)'}
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

/**
 * Session ID Popover Content Component
 * Displays both Agor session ID and agentic tool session ID with copy buttons
 */
const SessionIdPopoverContent: React.FC<{
  sessionId: string;
  sdkSessionId?: string;
  agenticTool?: string;
}> = ({ sessionId, sdkSessionId, agenticTool }) => {
  const { token } = theme.useToken();

  const handleCopyAgor = () => {
    copyToClipboard(sessionId, {
      showSuccess: true,
      successMessage: 'Agor session ID copied to clipboard',
    });
  };

  const handleCopySdk = () => {
    if (sdkSessionId) {
      copyToClipboard(sdkSessionId, {
        showSuccess: true,
        successMessage: `${agenticTool || 'SDK'} session ID copied to clipboard`,
      });
    }
  };

  return (
    <div style={{ width: 400, maxWidth: '90vw' }}>
      {/* Agor Session ID */}
      <div style={{ marginBottom: sdkSessionId ? 16 : 0 }}>
        <div style={{ fontWeight: 600, fontSize: '0.95em', marginBottom: 8 }}>Agor Session ID</div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: 8,
            background: token.colorBgContainer,
            borderRadius: token.borderRadius,
            border: `1px solid ${token.colorBorder}`,
          }}
        >
          <div style={{ flex: 1, fontFamily: token.fontFamilyCode, fontSize: '0.9em' }}>
            <div style={{ color: token.colorTextSecondary, fontSize: '0.85em', marginBottom: 2 }}>
              {sessionId.substring(0, 8)}
            </div>
            <div style={{ wordBreak: 'break-all', fontSize: '0.75em', opacity: 0.7 }}>
              {sessionId}
            </div>
          </div>
          <Tag
            icon={<CopyOutlined />}
            color={PILL_COLORS.session}
            style={{ cursor: 'pointer', margin: 0 }}
            onClick={handleCopyAgor}
          >
            Copy
          </Tag>
        </div>
      </div>

      {/* SDK Session ID (if available) */}
      {sdkSessionId && (
        <div>
          <div style={{ fontWeight: 600, fontSize: '0.95em', marginBottom: 8 }}>
            {agenticTool || 'SDK'} Session ID
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: 8,
              background: token.colorBgContainer,
              borderRadius: token.borderRadius,
              border: `1px solid ${token.colorBorder}`,
            }}
          >
            <div style={{ flex: 1, fontFamily: token.fontFamilyCode, fontSize: '0.9em' }}>
              <div style={{ color: token.colorTextSecondary, fontSize: '0.85em', marginBottom: 2 }}>
                {sdkSessionId.substring(0, 8)}
              </div>
              <div style={{ wordBreak: 'break-all', fontSize: '0.75em', opacity: 0.7 }}>
                {sdkSessionId}
              </div>
            </div>
            <Tag
              icon={<CopyOutlined />}
              color={PILL_COLORS.session}
              style={{ cursor: 'pointer', margin: 0 }}
              onClick={handleCopySdk}
            >
              Copy
            </Tag>
          </div>
        </div>
      )}
    </div>
  );
};

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
  const shortId = displayId.substring(0, 8);

  const pill = (
    <Tag
      icon={showCopy ? <CopyOutlined /> : <CodeOutlined />}
      color={PILL_COLORS.session}
      style={{ cursor: showCopy ? 'pointer' : 'default', ...style }}
    >
      <span style={{ fontFamily: token.fontFamilyCode }}>{shortId}</span>
    </Tag>
  );

  if (!showCopy) {
    return pill;
  }

  return (
    <Popover
      content={
        <SessionIdPopoverContent
          sessionId={sessionId}
          sdkSessionId={sdkSessionId}
          agenticTool={agenticTool}
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
          <div>Forked from session {fromSessionId.substring(0, 8)}</div>
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
        FORKED from {fromSessionId.substring(0, 8)}
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
          <div>Spawned from session {fromSessionId.substring(0, 8)}</div>
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
        SPAWNED from {fromSessionId.substring(0, 8)}
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

interface WorktreePillProps extends BasePillProps {
  managed?: boolean;
}

export const WorktreePill: React.FC<WorktreePillProps> = ({ managed = true, style }) => {
  const { token } = theme.useToken();

  return (
    <Tag color={PILL_COLORS.worktree} style={style}>
      <span style={{ fontFamily: token.fontFamilyCode }}>{managed ? 'Managed' : 'Worktree'}</span>
    </Tag>
  );
};

interface DirtyStatePillProps extends BasePillProps {}

export const DirtyStatePill: React.FC<DirtyStatePillProps> = ({ style }) => {
  const { token } = theme.useToken();

  return (
    <Tag icon={<EditOutlined />} color={PILL_COLORS.warning} style={style}>
      <span style={{ fontFamily: token.fontFamilyCode }}>uncommitted changes</span>
    </Tag>
  );
};

interface BranchPillProps extends BasePillProps {
  branch: string;
}

export const BranchPill: React.FC<BranchPillProps> = ({ branch, style }) => {
  const { token } = theme.useToken();

  return (
    <Tag icon={<BranchesOutlined />} color={PILL_COLORS.git} style={style}>
      <span style={{ fontFamily: token.fontFamilyCode }}>{branch}</span>
    </Tag>
  );
};

interface RepoPillProps extends BasePillProps {
  repoName: string;
  worktreeName?: string;
  onClick?: () => void;
}

export const RepoPill: React.FC<RepoPillProps> = ({
  repoName,
  worktreeName,
  onClick,
  size,
  style,
}) => {
  const { token } = theme.useToken();

  return (
    <Tag
      icon={<BranchesOutlined />}
      color="cyan"
      style={{ ...style, cursor: onClick ? 'pointer' : 'default' }}
      onClick={onClick}
    >
      <span style={{ fontFamily: token.fontFamilyCode }}>
        {repoName}
        {worktreeName && (
          <>
            {' '}
            <ApartmentOutlined style={{ fontSize: '0.85em', opacity: 0.7 }} /> {worktreeName}
          </>
        )}
      </span>
    </Tag>
  );
};

interface IssuePillProps extends BasePillProps {
  issueUrl: string;
  issueNumber?: string;
}

export const IssuePill: React.FC<IssuePillProps> = ({ issueUrl, issueNumber, style }) => {
  const displayText = issueNumber || issueUrl.split('/').pop() || '?';

  return (
    <Tag
      icon={<GithubOutlined />}
      color={PILL_COLORS.git}
      style={{ ...style, cursor: 'pointer' }}
      onClick={() => window.open(issueUrl, '_blank')}
    >
      Issue: {displayText}
    </Tag>
  );
};

interface PullRequestPillProps extends BasePillProps {
  prUrl: string;
  prNumber?: string;
}

export const PullRequestPill: React.FC<PullRequestPillProps> = ({ prUrl, prNumber, style }) => {
  const displayText = prNumber || prUrl.split('/').pop() || '?';

  return (
    <Tag
      icon={<GithubOutlined />}
      color={PILL_COLORS.git}
      style={{ ...style, cursor: 'pointer' }}
      onClick={() => window.open(prUrl, '_blank')}
    >
      PR: {displayText}
    </Tag>
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
