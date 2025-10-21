import type { AgorClient } from '@agor/core/api';
import {
  ApiOutlined,
  BranchesOutlined,
  ForkOutlined,
  SendOutlined,
  SettingOutlined,
  StopOutlined,
} from '@ant-design/icons';
import {
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
import type {
  MCPServer,
  PermissionMode,
  PermissionScope,
  Repo,
  Session,
  User,
  Worktree,
} from '../../types';
import { TaskStatus } from '../../types';
import { ConversationView } from '../ConversationView';
import { CreatedByTag } from '../metadata';
import { PermissionModeSelector } from '../PermissionModeSelector';
import {
  ForkPill,
  MessageCountPill,
  RepoPill,
  SessionIdPill,
  SpawnPill,
  ToolCountPill,
} from '../Pill';
import { ToolIcon } from '../ToolIcon';

const { Title, Text } = Typography;
const { TextArea } = Input;

// Re-export PermissionMode from SDK for convenience
export type { PermissionMode };

interface SessionDrawerProps {
  client: AgorClient | null;
  session: Session | null;
  users?: User[];
  currentUserId?: string;
  repos?: Repo[];
  worktrees?: Worktree[];
  mcpServers?: MCPServer[];
  sessionMcpServerIds?: string[];
  open: boolean;
  onClose: () => void;
  onSendPrompt?: (prompt: string, permissionMode?: PermissionMode) => void;
  onFork?: (prompt: string) => void;
  onSubtask?: (prompt: string) => void;
  onPermissionDecision?: (
    sessionId: string,
    requestId: string,
    taskId: string,
    allow: boolean,
    scope: PermissionScope
  ) => void;
  onOpenSettings?: (sessionId: string) => void;
  onOpenWorktree?: (worktreeId: string) => void;
  onUpdateSession?: (sessionId: string, updates: Partial<Session>) => void;
}

const SessionDrawer = ({
  client,
  session,
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
  onSubtask,
  onPermissionDecision,
  onOpenSettings,
  onOpenWorktree,
  onUpdateSession,
}: SessionDrawerProps) => {
  const { token } = theme.useToken();
  const [inputValue, setInputValue] = React.useState('');

  // Get agent-aware default permission mode (wrapped in useCallback for hook deps)
  const getDefaultPermissionMode = React.useCallback((agent?: string): PermissionMode => {
    return agent === 'codex' ? 'auto' : 'acceptEdits';
  }, []);

  const [permissionMode, setPermissionMode] = React.useState<PermissionMode>(
    session?.permission_config?.mode || getDefaultPermissionMode(session?.agentic_tool)
  );
  const [scrollToBottom, setScrollToBottom] = React.useState<(() => void) | null>(null);
  const [isStopping, setIsStopping] = React.useState(false);

  // Update permission mode when session changes
  React.useEffect(() => {
    if (session?.permission_config?.mode) {
      setPermissionMode(session.permission_config.mode);
    } else if (session?.agentic_tool) {
      // Set default based on agentic tool type if no permission mode is configured
      setPermissionMode(getDefaultPermissionMode(session.agentic_tool));
    }
  }, [session?.permission_config?.mode, session?.agentic_tool, getDefaultPermissionMode]);

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

  const handleSubtask = () => {
    if (inputValue.trim()) {
      onSubtask?.(inputValue);
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

  return (
    <Drawer
      title={
        <Space size={12} align="start">
          <ToolIcon tool={session.agentic_tool} size={40} />
          <div style={{ flex: 1 }}>
            <div style={{ marginBottom: 4 }}>
              <Text strong style={{ fontSize: 18 }}>
                {session.title || session.description || session.agentic_tool}
              </Text>
              <Badge
                status={getStatusColor()}
                text={session.status.toUpperCase()}
                style={{ marginLeft: 12 }}
              />
            </div>
            {session.description && session.description !== session.title && (
              <div style={{ marginBottom: 4 }}>
                <Text type="secondary" style={{ fontSize: 13 }}>
                  {typeof session.description === 'string'
                    ? session.description
                    : JSON.stringify(session.description)}
                </Text>
              </div>
            )}
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
        onOpenSettings && (
          <Tooltip title="Session Settings">
            <Button
              type="text"
              icon={<SettingOutlined />}
              onClick={() => onOpenSettings(session.session_id)}
            />
          </Tooltip>
        )
      }
      placement="right"
      width={720}
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
      {/* Genealogy Tags */}
      {(isForked || isSpawned) && (
        <div style={{ marginBottom: token.sizeUnit }}>
          <Space size={4} wrap>
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
          </Space>
        </div>
      )}

      {/* Worktree Info */}
      {(() => {
        // Find worktree and repo from session.worktree_id
        const worktree = worktrees.find(w => w.worktree_id === session.worktree_id);
        const repo = worktree ? repos.find(r => r.repo_id === worktree.repo_id) : null;

        return worktree && repo ? (
          <div style={{ marginBottom: token.sizeUnit }}>
            <RepoPill
              repoName={repo.slug}
              worktreeName={worktree.name}
              onClick={onOpenWorktree ? () => onOpenWorktree(worktree.worktree_id) : undefined}
            />
          </div>
        ) : null;
      })()}

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

      {/* MCP Servers */}
      {sessionMcpServerIds.length > 0 && (
        <div style={{ marginBottom: token.sizeUnit }}>
          <Space size={4} wrap>
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
            placeholder="Send a prompt, fork, or create a subtask..."
            autoSize={{ minRows: 1, maxRows: 10 }}
            onPressEnter={e => {
              if (e.shiftKey) {
                return;
              }
              e.preventDefault();
              handleSendPrompt();
            }}
          />
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Space size={8}>
              <SessionIdPill sessionId={session.session_id} showCopy={true} />
              <MessageCountPill count={session.message_count} />
              <ToolCountPill count={session.tool_use_count} />
            </Space>
            <Space size={8}>
              {/* Permission Mode Selector - Agentic tool-specific options */}
              <PermissionModeSelector
                value={permissionMode}
                onChange={handlePermissionModeChange}
                agentic_tool={session.agentic_tool}
                compact
                size="small"
                width={200}
              />
              {isRunning && <Spin size="small" />}
              <Button.Group>
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
                <Tooltip title={isRunning ? 'Session is running...' : 'Spawn Subtask'}>
                  <Button
                    icon={<BranchesOutlined />}
                    onClick={handleSubtask}
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
              </Button.Group>
            </Space>
          </Space>
        </Space>
      </div>
    </Drawer>
  );
};

export default SessionDrawer;
