import type { AgorClient } from '@agor/core/api';
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  MCPServer,
  PermissionMode,
  PermissionScope,
  Repo,
  Session,
  User,
  Worktree,
} from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import {
  ApiOutlined,
  BranchesOutlined,
  CodeOutlined,
  DeleteOutlined,
  ForkOutlined,
  SendOutlined,
  SettingOutlined,
  StopOutlined,
} from '@ant-design/icons';
import {
  App,
  Badge,
  Button,
  Divider,
  Drawer,
  Input,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import React from 'react';
import { useTasks } from '../../hooks/useTasks';
import spawnSubsessionTemplate from '../../templates/spawn_subsession.hbs?raw';
import { compileTemplate } from '../../utils/templates';
import { ConversationView } from '../ConversationView';
import { EnvironmentPill } from '../EnvironmentPill';
import { CreatedByTag } from '../metadata';
import { PermissionModeSelector } from '../PermissionModeSelector';
import {
  ContextWindowPill,
  ForkPill,
  MessageCountPill,
  RepoPill,
  SessionIdPill,
  SpawnPill,
  TokenCountPill,
} from '../Pill';
import { ToolIcon } from '../ToolIcon';

const { TextArea } = Input;

// Re-export PermissionMode from SDK for convenience
export type { PermissionMode };

// Compile the spawn subsession template once at module level
const compiledSpawnSubsessionTemplate = compileTemplate<{ userPrompt: string }>(
  spawnSubsessionTemplate
);

interface SessionDrawerProps {
  client: AgorClient | null;
  session: Session | null;
  worktree?: Worktree | null; // Pre-selected worktree for this session
  users?: User[];
  currentUserId?: string;
  repos?: Repo[];
  worktrees?: Worktree[]; // Still needed for other potential uses
  mcpServers?: MCPServer[];
  sessionMcpServerIds?: string[];
  open: boolean;
  onClose: () => void;
  onSendPrompt?: (prompt: string, permissionMode?: PermissionMode) => void;
  onFork?: (prompt: string) => void;
  onSubsession?: (prompt: string) => void;
  onPermissionDecision?: (
    sessionId: string,
    requestId: string,
    taskId: string,
    allow: boolean,
    scope: PermissionScope
  ) => void;
  onOpenSettings?: (sessionId: string) => void;
  onOpenWorktree?: (worktreeId: string) => void;
  onOpenTerminal?: (commands: string[]) => void;
  onUpdateSession?: (sessionId: string, updates: Partial<Session>) => void;
  onDelete?: (sessionId: string) => void;
  onStartEnvironment?: (worktreeId: string) => void;
  onStopEnvironment?: (worktreeId: string) => void;
}

const SessionDrawer = ({
  client,
  session,
  worktree = null,
  users = [],
  currentUserId,
  repos = [],
  worktrees = [],
  mcpServers = [],
  sessionMcpServerIds = [],
  open,
  onClose,
  onSendPrompt,
  onFork,
  onSubsession,
  onPermissionDecision,
  onOpenSettings,
  onOpenWorktree,
  onOpenTerminal,
  onUpdateSession,
  onDelete,
  onStartEnvironment,
  onStopEnvironment,
}: SessionDrawerProps) => {
  const { token } = theme.useToken();
  const { modal } = App.useApp();
  const [inputValue, setInputValue] = React.useState('');

  // Get agent-aware default permission mode (wrapped in useCallback for hook deps)
  const getDefaultPermissionMode = React.useCallback((agent?: string): PermissionMode => {
    return agent === 'codex' ? 'auto' : 'acceptEdits';
  }, []);

  const [permissionMode, setPermissionMode] = React.useState<PermissionMode>(
    session?.permission_config?.mode || getDefaultPermissionMode(session?.agentic_tool)
  );
  const [codexSandboxMode, setCodexSandboxMode] = React.useState<CodexSandboxMode>(
    session?.permission_config?.codex?.sandboxMode || 'workspace-write'
  );
  const [codexApprovalPolicy, setCodexApprovalPolicy] = React.useState<CodexApprovalPolicy>(
    session?.permission_config?.codex?.approvalPolicy || 'on-request'
  );
  const [scrollToBottom, setScrollToBottom] = React.useState<(() => void) | null>(null);
  const [isStopping, setIsStopping] = React.useState(false);

  // Fetch tasks for this session to calculate token totals
  const { tasks } = useTasks(client, session?.session_id || null);

  // Calculate token totals and breakdown across all tasks
  const tokenBreakdown = React.useMemo(() => {
    return tasks.reduce(
      (acc, task) => ({
        total: acc.total + (task.usage?.total_tokens || 0),
        input: acc.input + (task.usage?.input_tokens || 0),
        output: acc.output + (task.usage?.output_tokens || 0),
        cacheRead: acc.cacheRead + (task.usage?.cache_read_tokens || 0),
        cacheCreation: acc.cacheCreation + (task.usage?.cache_creation_tokens || 0),
        cost: acc.cost + (task.usage?.estimated_cost_usd || 0),
      }),
      { total: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 }
    );
  }, [tasks]);

  // Get latest context window from most recent completed task
  const latestContextWindow = React.useMemo(() => {
    // Find most recent task with context window data
    const tasksWithContext = tasks
      .filter(t => t.context_window && t.context_window_limit)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    if (tasksWithContext.length > 0) {
      return {
        used: tasksWithContext[0].context_window!,
        limit: tasksWithContext[0].context_window_limit!,
      };
    }
    return null;
  }, [tasks]);

  // Update permission mode when session changes
  React.useEffect(() => {
    if (session?.permission_config?.mode) {
      setPermissionMode(session.permission_config.mode);
    } else if (session?.agentic_tool) {
      // Set default based on agentic tool type if no permission mode is configured
      setPermissionMode(getDefaultPermissionMode(session.agentic_tool));
    }

    // Update Codex-specific permissions
    if (session?.agentic_tool === 'codex' && session?.permission_config?.codex) {
      setCodexSandboxMode(session.permission_config.codex.sandboxMode);
      setCodexApprovalPolicy(session.permission_config.codex.approvalPolicy);
    }
  }, [
    session?.permission_config?.mode,
    session?.permission_config?.codex,
    session?.agentic_tool,
    getDefaultPermissionMode,
  ]);

  // Scroll to bottom when drawer opens
  React.useEffect(() => {
    if (open && scrollToBottom) {
      // Small delay to ensure content is rendered
      setTimeout(() => {
        scrollToBottom();
      }, 100);
    }
  }, [open, scrollToBottom]);

  // Early return if no session (drawer should not be open without a session)
  // IMPORTANT: Must be after all hooks to satisfy Rules of Hooks
  if (!session) {
    return null;
  }

  const handleDelete = () => {
    modal.confirm({
      title: 'Delete Session',
      content: 'Are you sure you want to delete this session? This action cannot be undone.',
      okText: 'Delete',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: () => {
        onDelete?.(session.session_id);
        onClose(); // Close drawer after deletion
      },
    });
  };

  const handleSendPrompt = () => {
    if (inputValue.trim()) {
      onSendPrompt?.(inputValue, permissionMode);
      setInputValue('');
    }
  };

  const handleStop = async () => {
    if (!session || !client || isStopping) {
      if (isStopping) {
        console.log('⏳ Stop already in progress, ignoring duplicate request');
      }
      return;
    }

    try {
      setIsStopping(true);
      console.log(`🛑 Stopping execution for session ${session.session_id.substring(0, 8)}...`);

      // Call the stop endpoint using FeathersJS client
      await client.service(`sessions/${session.session_id}/stop`).create({});

      console.log('✅ Stop request sent successfully');
    } catch (error) {
      console.error('❌ Failed to stop execution:', error);
    } finally {
      // Reset after a short delay to allow WebSocket state updates
      setTimeout(() => setIsStopping(false), 2000);
    }
  };

  const handleFork = () => {
    if (inputValue.trim()) {
      onFork?.(inputValue);
      setInputValue('');
    }
  };

  const handleSubsession = () => {
    if (inputValue.trim()) {
      // Generate meta-prompt using the template
      const metaPrompt = compiledSpawnSubsessionTemplate({
        userPrompt: inputValue,
      });

      // Send meta-prompt to the PARENT session (agent will use MCP tool)
      onSendPrompt?.(metaPrompt, permissionMode);
      setInputValue('');
    }
  };

  const handlePermissionModeChange = (newMode: PermissionMode) => {
    setPermissionMode(newMode);

    // Persist to database immediately (will broadcast via WebSocket)
    if (session && onUpdateSession) {
      onUpdateSession(session.session_id, {
        permission_config: {
          ...session.permission_config,
          mode: newMode,
        },
      });
    }
  };

  const handleCodexPermissionChange = (
    sandbox: CodexSandboxMode,
    approval: CodexApprovalPolicy
  ) => {
    setCodexSandboxMode(sandbox);
    setCodexApprovalPolicy(approval);

    // Persist to database immediately (will broadcast via WebSocket)
    if (session && onUpdateSession) {
      onUpdateSession(session.session_id, {
        permission_config: {
          ...session.permission_config,
          codex: {
            sandboxMode: sandbox,
            approvalPolicy: approval,
          },
        },
      });
    }
  };

  const getStatusColor = () => {
    switch (session.status) {
      case 'running':
        return 'processing';
      case 'completed':
        return 'success';
      case 'failed':
        return 'error';
      default:
        return 'default';
    }
  };

  const isForked = !!session.genealogy.forked_from_session_id;
  const isSpawned = !!session.genealogy.parent_session_id;

  // Check if session is currently running (disable prompts to avoid confusion)
  const isRunning = session.status === TaskStatus.RUNNING;

  // Get repo from worktree (worktree is passed from parent)
  const repo = worktree ? repos.find(r => r.repo_id === worktree.repo_id) : null;

  return (
    <Drawer
      title={
        <Space size={12} align="center">
          <ToolIcon tool={session.agentic_tool} size={40} />
          <div style={{ flex: 1 }}>
            <div style={{ marginBottom: 4 }}>
              <Typography.Text strong style={{ fontSize: 18 }}>
                {session.title || session.description || session.agentic_tool}
              </Typography.Text>
              <Badge
                status={getStatusColor()}
                text={session.status.toUpperCase()}
                style={{ marginLeft: 12 }}
              />
            </div>
            {session.created_by && (
              <div>
                <CreatedByTag
                  createdBy={session.created_by}
                  currentUserId={currentUserId}
                  users={users}
                  prefix="Created by"
                />
              </div>
            )}
          </div>
        </Space>
      }
      extra={
        <Space size={4}>
          {onDelete && (
            <Tooltip title="Delete Session">
              <Button type="text" danger icon={<DeleteOutlined />} onClick={handleDelete} />
            </Tooltip>
          )}
          {onOpenTerminal && worktree && (
            <Tooltip title="Open terminal in worktree directory">
              <Button
                type="text"
                icon={<CodeOutlined />}
                onClick={() => onOpenTerminal([`cd ${worktree.path}`])}
              />
            </Tooltip>
          )}
          {onOpenSettings && (
            <Tooltip title="Session Settings">
              <Button
                type="text"
                icon={<SettingOutlined />}
                onClick={() => onOpenSettings(session.session_id)}
              />
            </Tooltip>
          )}
        </Space>
      }
      placement="right"
      width={820}
      open={open}
      onClose={onClose}
      styles={{
        body: {
          paddingBottom: 0,
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
        },
      }}
    >
      {/* All pills in one line */}
      {(isForked || isSpawned || worktree || sessionMcpServerIds.length > 0) && (
        <div style={{ marginBottom: token.sizeUnit }}>
          <Space size={8} wrap>
            {/* Genealogy Tags */}
            {isForked && session.genealogy.forked_from_session_id && (
              <ForkPill
                fromSessionId={session.genealogy.forked_from_session_id}
                taskId={session.genealogy.fork_point_task_id}
              />
            )}
            {isSpawned && session.genealogy.parent_session_id && (
              <SpawnPill
                fromSessionId={session.genealogy.parent_session_id}
                taskId={session.genealogy.spawn_point_task_id}
              />
            )}
            {/* Worktree Info */}
            {worktree && repo && (
              <RepoPill
                repoName={repo.slug}
                worktreeName={worktree.name}
                onClick={onOpenWorktree ? () => onOpenWorktree(worktree.worktree_id) : undefined}
              />
            )}
            {worktree && repo && (
              <EnvironmentPill
                repo={repo}
                worktree={worktree}
                onEdit={
                  onOpenWorktree
                    ? () => {
                        onClose(); // Close drawer first to avoid focus trap
                        onOpenWorktree(worktree.worktree_id);
                      }
                    : undefined
                }
                onStartEnvironment={onStartEnvironment}
                onStopEnvironment={onStopEnvironment}
              />
            )}
            {/* MCP Servers */}
            {sessionMcpServerIds
              .map(serverId => mcpServers.find(s => s.mcp_server_id === serverId))
              .filter(Boolean)
              .map(server => (
                <Tag key={server?.mcp_server_id} color="purple" icon={<ApiOutlined />}>
                  {server?.display_name || server?.name}
                </Tag>
              ))}
          </Space>
        </div>
      )}

      {/* Concepts - TODO: Re-implement with contextFiles */}
      {/* {session.contextFiles && session.contextFiles.length > 0 && (
        <div style={{ marginBottom: token.sizeUnit }}>
          <Title level={5}>Loaded Context Files</Title>
          <Space size={4} wrap>
            {session.contextFiles.map((file) => (
              <ConceptPill key={file} name={file} />
            ))}
          </Space>
        </div>
      )} */}

      <Divider style={{ margin: `${token.sizeUnit * 2}px 0` }} />

      {/* Task-Centric Conversation View - Scrollable */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <ConversationView
          client={client}
          sessionId={session.session_id}
          agentic_tool={session.agentic_tool}
          sessionModel={session.model_config?.model}
          users={users}
          currentUserId={currentUserId}
          onScrollRef={setScrollToBottom}
          onPermissionDecision={onPermissionDecision}
        />
      </div>

      {/* Input Box Footer */}
      <div
        style={{
          position: 'sticky',
          bottom: 0,
          background: token.colorBgContainer,
          borderTop: `1px solid ${token.colorBorder}`,
          padding: `${token.sizeUnit * 2}px ${token.sizeUnit * 6}px`,
          marginLeft: -token.sizeUnit * 6,
          marginRight: -token.sizeUnit * 6,
          marginBottom: -token.sizeUnit * 6,
        }}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={8}>
          <TextArea
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            placeholder="Send a prompt, fork, or create a subsession..."
            autoSize={{ minRows: 1, maxRows: 10 }}
            onPressEnter={e => {
              if (e.shiftKey) {
                return;
              }
              e.preventDefault();
              // Respect same disabled conditions as Send button (isRunning || !inputValue.trim())
              if (!isRunning && inputValue.trim()) {
                handleSendPrompt();
              }
            }}
          />
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Space size={8}>
              <SessionIdPill
                sessionId={session.session_id}
                sdkSessionId={session.sdk_session_id}
                agenticTool={session.agentic_tool}
                showCopy={true}
              />
              <MessageCountPill count={session.message_count} />
              {tokenBreakdown.total > 0 && (
                <TokenCountPill
                  count={tokenBreakdown.total}
                  estimatedCost={tokenBreakdown.cost}
                  inputTokens={tokenBreakdown.input}
                  outputTokens={tokenBreakdown.output}
                  cacheReadTokens={tokenBreakdown.cacheRead}
                  cacheCreationTokens={tokenBreakdown.cacheCreation}
                />
              )}
              {latestContextWindow && (
                <ContextWindowPill
                  used={latestContextWindow.used}
                  limit={latestContextWindow.limit}
                />
              )}
            </Space>
            <Space size={8}>
              {/* Permission Mode Selector - Agentic tool-specific options */}
              <PermissionModeSelector
                value={permissionMode}
                onChange={handlePermissionModeChange}
                agentic_tool={session.agentic_tool}
                codexSandboxMode={codexSandboxMode}
                codexApprovalPolicy={codexApprovalPolicy}
                onCodexChange={handleCodexPermissionChange}
                compact
                size="small"
              />
              {isRunning && <Spin size="small" />}
              <Space.Compact>
                <Tooltip
                  title={
                    isStopping
                      ? 'Stopping...'
                      : isRunning
                        ? 'Stop Execution'
                        : 'No active execution'
                  }
                >
                  <Button
                    danger
                    icon={<StopOutlined />}
                    onClick={handleStop}
                    disabled={!isRunning || isStopping}
                    loading={isStopping}
                  />
                </Tooltip>
                <Tooltip title={isRunning ? 'Session is running...' : 'Fork Session'}>
                  <Button
                    icon={<ForkOutlined />}
                    onClick={handleFork}
                    disabled={isRunning || !inputValue.trim()}
                  />
                </Tooltip>
                <Tooltip title={isRunning ? 'Session is running...' : 'Spawn Subsession'}>
                  <Button
                    icon={<BranchesOutlined />}
                    onClick={handleSubsession}
                    disabled={isRunning || !inputValue.trim()}
                  />
                </Tooltip>
                <Tooltip title={isRunning ? 'Session is running...' : 'Send Prompt'}>
                  <Button
                    type="primary"
                    icon={<SendOutlined />}
                    onClick={handleSendPrompt}
                    disabled={isRunning || !inputValue.trim()}
                  />
                </Tooltip>
              </Space.Compact>
            </Space>
          </Space>
        </Space>
      </div>
    </Drawer>
  );
};

export default SessionDrawer;
