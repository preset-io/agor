import {
  BranchesOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CodeOutlined,
  CopyOutlined,
  EditOutlined,
  FileTextOutlined,
  ForkOutlined,
  GithubOutlined,
  MessageOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { message, Tag, type TagProps, theme } from 'antd';
import type React from 'react';

/**
 * Standardized color palette for pills/badges
 * Using subset of Ant Design preset colors for consistency
 */
export const PILL_COLORS = {
  // Metadata
  message: 'blue', // Message counts
  tool: 'purple', // Tool usage
  git: 'geekblue', // Git info
  session: 'default', // Session IDs

  // Status
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

interface MessageCountPillProps extends BasePillProps {
  count: number;
}

export const MessageCountPill: React.FC<MessageCountPillProps> = ({ count, size, style }) => (
  <Tag icon={<MessageOutlined />} color={PILL_COLORS.message} style={style}>
    {count} {count === 1 ? 'message' : 'messages'}
  </Tag>
);

interface ToolCountPillProps extends BasePillProps {
  count: number;
  toolName?: string;
}

export const ToolCountPill: React.FC<ToolCountPillProps> = ({ count, toolName, size, style }) => (
  <Tag icon={<ToolOutlined />} color={PILL_COLORS.tool} style={style}>
    {count} {toolName || 'tools'}
  </Tag>
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

interface SessionIdPillProps extends BasePillProps {
  sessionId: string;
  showCopy?: boolean;
}

export const SessionIdPill: React.FC<SessionIdPillProps> = ({
  sessionId,
  showCopy = true,
  size = 'small',
  style,
}) => {
  const { token } = theme.useToken();
  const shortId = sessionId.substring(0, 8);

  const handleCopy = () => {
    navigator.clipboard.writeText(sessionId);
    message.success('Session ID copied to clipboard');
  };

  if (showCopy) {
    return (
      <Tag
        icon={<CopyOutlined />}
        color={PILL_COLORS.session}
        style={{ cursor: 'pointer', ...style }}
        onClick={handleCopy}
      >
        <span style={{ fontFamily: token.fontFamilyCode }}>{shortId}</span>
      </Tag>
    );
  }

  return (
    <Tag icon={<CodeOutlined />} color={PILL_COLORS.session} style={style}>
      <span style={{ fontFamily: token.fontFamilyCode }}>{shortId}</span>
    </Tag>
  );
};

interface StatusPillProps extends BasePillProps {
  status: 'completed' | 'failed' | 'running' | 'pending';
}

export const StatusPill: React.FC<StatusPillProps> = ({ status, size, style }) => {
  const config = {
    completed: { icon: <CheckCircleOutlined />, color: PILL_COLORS.success, text: 'Completed' },
    failed: { icon: <CloseCircleOutlined />, color: PILL_COLORS.error, text: 'Failed' },
    running: { icon: <ToolOutlined />, color: PILL_COLORS.processing, text: 'Running' },
    pending: { icon: <ToolOutlined />, color: PILL_COLORS.session, text: 'Pending' },
  }[status];

  return (
    <Tag icon={config.icon} color={config.color} style={style}>
      {config.text}
    </Tag>
  );
};

interface ForkPillProps extends BasePillProps {
  fromSessionId: string;
  taskId?: string;
}

export const ForkPill: React.FC<ForkPillProps> = ({ fromSessionId, taskId, size, style }) => (
  <Tag icon={<ForkOutlined />} color={PILL_COLORS.fork} style={style}>
    FORKED from {fromSessionId.substring(0, 7)}
    {taskId && ` at ${taskId.substring(0, 7)}`}
  </Tag>
);

interface SpawnPillProps extends BasePillProps {
  fromSessionId: string;
  taskId?: string;
}

export const SpawnPill: React.FC<SpawnPillProps> = ({ fromSessionId, taskId, size, style }) => (
  <Tag icon={<BranchesOutlined />} color={PILL_COLORS.spawn} style={style}>
    SPAWNED from {fromSessionId.substring(0, 7)}
    {taskId && ` at ${taskId.substring(0, 7)}`}
  </Tag>
);

interface ReportPillProps extends BasePillProps {
  reportId?: string;
}

export const ReportPill: React.FC<ReportPillProps> = ({ reportId, size, style }) => (
  <Tag icon={<FileTextOutlined />} color={PILL_COLORS.report} style={style}>
    {reportId ? `Report ${reportId.substring(0, 7)}` : 'Has Report'}
  </Tag>
);

interface ConceptPillProps extends BasePillProps {
  name: string;
}

export const ConceptPill: React.FC<ConceptPillProps> = ({ name, size, style }) => (
  <Tag color={PILL_COLORS.concept} style={style}>
    📦 {name}
  </Tag>
);

interface WorktreePillProps extends BasePillProps {
  managed?: boolean;
}

export const WorktreePill: React.FC<WorktreePillProps> = ({ managed = true, size, style }) => (
  <Tag color={PILL_COLORS.worktree} style={style}>
    {managed ? 'Managed' : 'Worktree'}
  </Tag>
);

interface DirtyStatePillProps extends BasePillProps {}

export const DirtyStatePill: React.FC<DirtyStatePillProps> = ({ size, style }) => (
  <Tag icon={<EditOutlined />} color={PILL_COLORS.warning} style={style}>
    uncommitted changes
  </Tag>
);

interface BranchPillProps extends BasePillProps {
  branch: string;
}

export const BranchPill: React.FC<BranchPillProps> = ({ branch, size, style }) => {
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
}

export const RepoPill: React.FC<RepoPillProps> = ({ repoName, worktreeName, size, style }) => {
  const { token } = theme.useToken();

  return (
    <Tag icon={<GithubOutlined />} color={PILL_COLORS.git} style={style}>
      <span style={{ fontFamily: token.fontFamilyCode }}>
        {repoName}
        {worktreeName && `:${worktreeName}`}
      </span>
    </Tag>
  );
};
