import type { SessionStatus, TaskStatus } from '@agor/core/types';
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
import { Tag, Tooltip, theme } from 'antd';
import type React from 'react';
import { copyToClipboard } from '../../utils/clipboard';

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
    {count}
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
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_tokens?: number;
      cache_read_tokens?: number;
      total_tokens?: number;
      estimated_cost_usd?: number;
    };
    model?: string;
    model_usage?: Record<
      string,
      {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens?: number;
        cacheCreationInputTokens?: number;
        contextWindow: number;
      }
    >;
    duration_ms?: number;
  };
}

export const ContextWindowPill: React.FC<ContextWindowPillProps> = ({
  used,
  limit,
  taskMetadata,
  style,
}) => {
  const percentage = Math.round((used / limit) * 100);

  // Color-code based on usage: green (<50%), yellow (50-80%), red (>80%)
  const getColor = () => {
    if (percentage < 50) return 'green';
    if (percentage < 80) return 'orange';
    return 'red';
  };

  const tooltipContent = (
    <div style={{ maxWidth: 600 }}>
      <div style={{ fontWeight: 'bold', marginBottom: 8 }}>Context Window Usage (This Turn)</div>
      <div>
        Fresh input: {used.toLocaleString()} / {limit.toLocaleString()} ({percentage}%)
      </div>
      <div style={{ fontSize: '0.85em', color: '#888', marginTop: 4 }}>
        Note: Shows fresh input after cache breakpoints. SDK doesn't provide session-level
        cumulative tracking.
      </div>

      {taskMetadata?.usage && (
        <>
          <div style={{ marginTop: 12, fontWeight: 'bold' }}>Token Breakdown:</div>
          <div style={{ fontSize: '0.9em', marginLeft: 8 }}>
            <div>Input (fresh): {taskMetadata.usage.input_tokens?.toLocaleString() || 0}</div>
            <div>Output: {taskMetadata.usage.output_tokens?.toLocaleString() || 0}</div>
            <div>
              Cache creation: {taskMetadata.usage.cache_creation_tokens?.toLocaleString() || 0}
            </div>
            <div>Cache read: {taskMetadata.usage.cache_read_tokens?.toLocaleString() || 0}</div>
            <div>Total: {taskMetadata.usage.total_tokens?.toLocaleString() || 0}</div>
            {taskMetadata.usage.estimated_cost_usd !== undefined && (
              <div>Cost: ${taskMetadata.usage.estimated_cost_usd.toFixed(4)}</div>
            )}
          </div>
        </>
      )}

      {taskMetadata?.model && (
        <div style={{ marginTop: 8, fontSize: '0.9em' }}>
          <span style={{ fontWeight: 500 }}>Model:</span> {taskMetadata.model}
        </div>
      )}

      {taskMetadata?.duration_ms !== undefined && (
        <div style={{ marginTop: 4, fontSize: '0.9em' }}>
          <span style={{ fontWeight: 500 }}>Duration:</span>{' '}
          {(taskMetadata.duration_ms / 1000).toFixed(2)}s
        </div>
      )}

      {taskMetadata?.model_usage && Object.keys(taskMetadata.model_usage).length > 0 && (
        <>
          <div style={{ marginTop: 12, fontWeight: 'bold' }}>Per-Model Usage:</div>
          {Object.entries(taskMetadata.model_usage).map(([modelId, usage]) => (
            <div key={modelId} style={{ marginTop: 8, fontSize: '0.85em', marginLeft: 8 }}>
              <div style={{ fontWeight: 500 }}>{modelId}:</div>
              <div style={{ marginLeft: 8 }}>
                <div>Input: {usage.inputTokens?.toLocaleString() || 0}</div>
                <div>Output: {usage.outputTokens?.toLocaleString() || 0}</div>
                {usage.cacheCreationInputTokens !== undefined && (
                  <div>Cache creation: {usage.cacheCreationInputTokens.toLocaleString()}</div>
                )}
                {usage.cacheReadInputTokens !== undefined && (
                  <div>Cache read: {usage.cacheReadInputTokens.toLocaleString()}</div>
                )}
                <div>Limit: {usage.contextWindow?.toLocaleString() || 0}</div>
              </div>
            </div>
          ))}
        </>
      )}

      {taskMetadata && (
        <>
          <div
            style={{
              marginTop: 16,
              fontWeight: 'bold',
              borderTop: '1px solid #333',
              paddingTop: 8,
            }}
          >
            Raw JSON Payload:
          </div>
          <pre
            style={{
              fontSize: '0.75em',
              fontFamily: 'monospace',
              background: '#1a1a1a',
              padding: 8,
              borderRadius: 4,
              overflowX: 'auto',
              maxHeight: 300,
              marginTop: 4,
            }}
          >
            {JSON.stringify(taskMetadata, null, 2)}
          </pre>
        </>
      )}
    </div>
  );

  const pill = (
    <Tag icon={<PercentageOutlined />} color={getColor()} style={style}>
      {percentage}
    </Tag>
  );

  return <Tooltip title={tooltipContent}>{pill}</Tooltip>;
};

interface ModelPillProps extends BasePillProps {
  model: string;
}

export const ModelPill: React.FC<ModelPillProps> = ({ model, style }) => {
  // Simplify model name for display (e.g., "claude-sonnet-4-5-20250929" -> "sonnet-4.5")
  const getDisplayName = (modelId: string) => {
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
    return modelId; // Fallback to full ID
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
  showDirtyIndicator?: boolean;
}

export const GitStatePill: React.FC<GitStatePillProps> = ({
  branch,
  sha,
  showDirtyIndicator = true,
  style,
}) => {
  const { token } = theme.useToken();
  const isDirty = sha.endsWith('-dirty');
  const cleanSha = sha.replace('-dirty', '');
  const displaySha = cleanSha.substring(0, 7);

  return (
    <Tag
      icon={<ForkOutlined />}
      color={isDirty && showDirtyIndicator ? 'cyan' : PILL_COLORS.git}
      style={style}
    >
      {branch && <span>{branch} : </span>}
      <span style={{ fontFamily: token.fontFamilyCode }}>{displaySha}</span>
      {isDirty && showDirtyIndicator && ' (dirty)'}
    </Tag>
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
  const shortId = displayId.substring(0, 8);

  // Generate tooltip based on what we're showing
  const tooltipTitle = sdkSessionId
    ? `${agenticTool || 'SDK'} session ID: ${displayId}`
    : `Agor session ID: ${displayId}`;

  const handleCopy = () => {
    copyToClipboard(displayId, {
      showSuccess: true,
      successMessage: `${sdkSessionId ? 'SDK' : 'Agor'} Session ID copied to clipboard`,
    });
  };

  if (showCopy) {
    return (
      <Tooltip title={tooltipTitle}>
        <Tag
          icon={<CopyOutlined />}
          color={PILL_COLORS.session}
          style={{ cursor: 'pointer', ...style }}
          onClick={handleCopy}
        >
          <span style={{ fontFamily: token.fontFamilyCode }}>{shortId}</span>
        </Tag>
      </Tooltip>
    );
  }

  return (
    <Tooltip title={tooltipTitle}>
      <Tag icon={<CodeOutlined />} color={PILL_COLORS.session} style={style}>
        <span style={{ fontFamily: token.fontFamilyCode }}>{shortId}</span>
      </Tag>
    </Tooltip>
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
}

export const ForkPill: React.FC<ForkPillProps> = ({ fromSessionId, taskId, style }) => (
  <Tag icon={<ForkOutlined />} color={PILL_COLORS.fork} style={style}>
    FORKED from {fromSessionId.substring(0, 7)}
    {taskId && ` at ${taskId.substring(0, 7)}`}
  </Tag>
);

interface SpawnPillProps extends BasePillProps {
  fromSessionId: string;
  taskId?: string;
}

export const SpawnPill: React.FC<SpawnPillProps> = ({ fromSessionId, taskId, style }) => (
  <Tag icon={<BranchesOutlined />} color={PILL_COLORS.spawn} style={style}>
    SPAWNED from {fromSessionId.substring(0, 7)}
    {taskId && ` at ${taskId.substring(0, 7)}`}
  </Tag>
);

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
