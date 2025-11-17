import type { AgorClient } from '@agor/core/api';
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  MCPServer,
  Message,
  PermissionMode,
  PermissionScope,
  Repo,
  Session,
  SpawnConfig,
  User,
  Worktree,
} from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { normalizeRawSdkResponse } from '@agor/core/utils/sdk-normalizer';
import {
  ApiOutlined,
  BranchesOutlined,
  CodeOutlined,
  CopyOutlined,
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
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import React from 'react';
import { useConnectionDisabled } from '../../contexts/ConnectionContext';
import { useTasks } from '../../hooks/useTasks';
import spawnSubsessionTemplate from '../../templates/spawn_subsession.hbs?raw';
import { getContextWindowGradient } from '../../utils/contextWindow';
import { compileTemplate } from '../../utils/templates';
import { AutocompleteTextarea } from '../AutocompleteTextarea';
import { ConversationView } from '../ConversationView';
import { EnvironmentPill } from '../EnvironmentPill';
import { ForkSpawnModal } from '../ForkSpawnModal';
import { CreatedByTag } from '../metadata';
import { PermissionModeSelector } from '../PermissionModeSelector';
import {
  ContextWindowPill,
  ForkPill,
  IssuePill,
  MessageCountPill,
  PullRequestPill,
  RepoPill,
  SessionIdPill,
  SpawnPill,
  TimerPill,
  TokenCountPill,
} from '../Pill';
import { ThinkingModeSelector } from '../ThinkingModeSelector';
import { ToolIcon } from '../ToolIcon';

// Re-export PermissionMode from SDK for convenience
export type { PermissionMode };

// Compile the spawn subsession template once at module level
const compiledSpawnSubsessionTemplate = compileTemplate<{ userPrompt: string }>(
  spawnSubsessionTemplate
);

// Session title display configuration
const SESSION_TITLE_MAX_LINES = 2; // Limit title to 2 lines with CSS line-clamp
const SESSION_TITLE_FALLBACK_CHARS = 150; // Fallback truncation for unsupported browsers

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
  onSubsession?: (config: string | Partial<SpawnConfig>) => void;
  onPermissionDecision?: (
    sessionId: string,
    requestId: string,
    taskId: string,
    allow: boolean,
    scope: PermissionScope
  ) => void;
  onOpenSettings?: (sessionId: string) => void;
  onOpenWorktree?: (worktreeId: string) => void;
  onOpenTerminal?: (commands: string[], worktreeId?: string) => void;
  onUpdateSession?: (sessionId: string, updates: Partial<Session>) => void;
  onDelete?: (sessionId: string) => void;
  onStartEnvironment?: (worktreeId: string) => void;
  onStopEnvironment?: (worktreeId: string) => void;
  onViewLogs?: (worktreeId: string) => void;
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
  onViewLogs,
}: SessionDrawerProps) => {
  const { token } = theme.useToken();
  const { modal, message } = App.useApp();
  const connectionDisabled = useConnectionDisabled();

  // Per-session draft storage (persists across session switches, no parent re-renders!)
  const draftsRef = React.useRef<Map<string, string>>(new Map());

  // Local input state for current session
  const [inputValue, setInputValue] = React.useState(() => {
    return session ? draftsRef.current.get(session.session_id) || '' : '';
  });

  // Track previous session ID to detect switches
  const prevSessionIdRef = React.useRef(session?.session_id);

  // When session changes, save current draft and load new session's draft
  React.useEffect(() => {
    if (!session) return;

    if (prevSessionIdRef.current !== session.session_id) {
      // Save current draft before switching (if we had a previous session)
      if (prevSessionIdRef.current && inputValue.trim()) {
        draftsRef.current.set(prevSessionIdRef.current, inputValue);
      } else if (prevSessionIdRef.current) {
        draftsRef.current.delete(prevSessionIdRef.current);
      }

      // Load draft for new session
      setInputValue(draftsRef.current.get(session.session_id) || '');
      prevSessionIdRef.current = session.session_id;
    }
  }, [session, inputValue]);

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
  const [thinkingMode, setThinkingMode] = React.useState<'auto' | 'manual' | 'off'>(
    session?.model_config?.thinkingMode || 'auto'
  );
  const [scrollToBottom, setScrollToBottom] = React.useState<(() => void) | null>(null);
  const [isStopping, setIsStopping] = React.useState(false);
  const [queuedMessages, setQueuedMessages] = React.useState<Message[]>([]);
  const [spawnModalOpen, setSpawnModalOpen] = React.useState(false);

  // Fetch tasks for this session to calculate token totals
  const currentUser = users?.find((u) => u.user_id === currentUserId) || null;
  const { tasks } = useTasks(client, session?.session_id || null, currentUser, open);

  // Fetch queued messages for this session
  React.useEffect(() => {
    if (!client || !session) {
      return;
    }

    const fetchQueue = async () => {
      try {
        const response = await client
          .service(`/sessions/${session.session_id}/messages/queue`)
          .find();
        const data = (response as { data: Message[] }).data || [];
        setQueuedMessages(data);
      } catch (error) {
        console.error('[SessionDrawer] Failed to fetch queue:', error);
      }
    };

    fetchQueue();

    // Listen for queue updates via WebSocket
    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS types don't include .on/.off methods
    const messagesService = client.service('messages') as any;

    const handleQueued = (message: Message) => {
      if (message.session_id === session.session_id) {
        setQueuedMessages((prev) => {
          const updated = [...prev, message].sort(
            (a, b) => (a.queue_position ?? 0) - (b.queue_position ?? 0)
          );
          return updated;
        });
      }
    };

    // Use built-in 'removed' event instead of custom 'dequeued' event
    const handleMessageRemoved = (message: Message) => {
      console.log('[SessionDrawer] Message removed event received:', message);
      // Only process if it's a queued message for this session
      if (message.status === 'queued' && message.session_id === session.session_id) {
        console.log('[SessionDrawer] Removing queued message from UI:', message.message_id);
        setQueuedMessages((prev) => {
          const filtered = prev.filter((m) => m.message_id !== message.message_id);
          console.log('[SessionDrawer] Queue after removal:', filtered);
          return filtered;
        });
      } else {
        console.log(
          '[SessionDrawer] Removed event not for queued message in this session, ignoring'
        );
      }
    };

    messagesService.on('queued', handleQueued);
    messagesService.on('removed', handleMessageRemoved);

    return () => {
      messagesService.off('queued', handleQueued);
      messagesService.off('removed', handleMessageRemoved);
    };
  }, [client, session]); // Re-run when client or session changes

  // Calculate token totals and breakdown across all tasks (from raw SDK responses)
  // Use normalizer to handle different SDK formats consistently
  const tokenBreakdown = React.useMemo(() => {
    if (!session?.agentic_tool) {
      return { total: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 };
    }

    return tasks.reduce(
      (acc, task) => {
        if (!task.raw_sdk_response) return acc;

        // Normalize SDK response to get consistent token counts
        const normalized = normalizeRawSdkResponse(task.raw_sdk_response, session.agentic_tool);

        return {
          total: acc.total + normalized.tokenUsage.totalTokens,
          input: acc.input + normalized.tokenUsage.inputTokens,
          output: acc.output + normalized.tokenUsage.outputTokens,
          cacheRead: acc.cacheRead + normalized.tokenUsage.cacheReadTokens,
          cacheCreation: acc.cacheCreation + normalized.tokenUsage.cacheCreationTokens,
          cost: acc.cost + (normalized.costUsd || 0),
        };
      },
      { total: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 }
    );
  }, [tasks, session?.agentic_tool]);

  // Get latest context window from most recent task (uses computed_context_window)
  const latestContextWindow = React.useMemo(() => {
    if (!session?.agentic_tool) return null;

    // Find most recent task with computed context window
    for (let i = tasks.length - 1; i >= 0; i--) {
      const task = tasks[i];
      if (task.computed_context_window !== undefined && task.raw_sdk_response) {
        // Get context window limit from normalizer
        const normalized = normalizeRawSdkResponse(task.raw_sdk_response, session.agentic_tool);

        // Show pill even without limit (will display as "?")
        if (task.computed_context_window > 0) {
          return {
            used: task.computed_context_window, // Use stored computed value
            limit: normalized.contextWindowLimit || 0, // Allow 0 limit
            taskMetadata: {
              model: task.model,
              duration_ms: task.duration_ms,
              agentic_tool: session.agentic_tool,
              raw_sdk_response: task.raw_sdk_response,
            },
          };
        }
      }
    }
    return null;
  }, [tasks, session?.agentic_tool]);

  // Calculate gradient for footer background
  const footerGradient = React.useMemo(() => {
    if (!latestContextWindow) return undefined;
    return getContextWindowGradient(latestContextWindow.used, latestContextWindow.limit);
  }, [latestContextWindow]);

  const footerTimerTask = React.useMemo(() => {
    if (tasks.length === 0) {
      return null;
    }

    for (let index = tasks.length - 1; index >= 0; index -= 1) {
      const candidate = tasks[index];
      if (
        candidate.status === TaskStatus.RUNNING ||
        candidate.status === TaskStatus.STOPPING ||
        candidate.status === TaskStatus.AWAITING_PERMISSION
      ) {
        return candidate;
      }
    }

    return tasks[tasks.length - 1];
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

  // Update thinking mode when session changes
  React.useEffect(() => {
    if (session?.model_config?.thinkingMode) {
      setThinkingMode(session.model_config.thinkingMode);
    }
  }, [session?.model_config?.thinkingMode]);

  // Scroll to bottom when drawer opens or session changes
  React.useEffect(() => {
    if (open && scrollToBottom && session) {
      // Longer delay to ensure tasks are loaded and content is rendered
      const timeoutId = setTimeout(() => {
        scrollToBottom();
      }, 300);
      return () => clearTimeout(timeoutId);
    }
  }, [open, scrollToBottom, session]);

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

  const handleSendPrompt = async () => {
    if (!inputValue.trim()) return;

    const promptToSend = inputValue.trim();

    try {
      // If session is running, queue the message instead of sending immediately
      if (isRunning && client) {
        const response = (await client
          .service(`/sessions/${session.session_id}/messages/queue`)
          .create({
            prompt: promptToSend,
          })) as { success: boolean; message: Message; queue_position: number };

        // Optimistically update the UI immediately (don't wait for WebSocket event)
        if (response.message) {
          setQueuedMessages((prev) => {
            const updated = [...prev, response.message].sort(
              (a, b) => (a.queue_position ?? 0) - (b.queue_position ?? 0)
            );
            return updated;
          });
        }

        message.success(`Message queued at position ${response.message.queue_position}`);

        // Clear input immediately after successful queue
        setInputValue('');
        draftsRef.current.delete(session.session_id);
      } else {
        // Session is idle, send normally
        // Clear input before sending (onSendPrompt is sync)
        setInputValue('');
        draftsRef.current.delete(session.session_id);
        onSendPrompt?.(promptToSend, permissionMode);
      }
    } catch (error) {
      console.error('[SessionDrawer] Failed to send/queue:', error);
      message.error(
        `Failed to ${isRunning ? 'queue' : 'send'} message: ${error instanceof Error ? error.message : String(error)}`
      );
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
      // Clear input and draft after forking
      setInputValue('');
      draftsRef.current.delete(session.session_id);
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
      // Clear input and draft after subsession
      setInputValue('');
      draftsRef.current.delete(session.session_id);
    }
  };

  const handleSpawnModalConfirm = async (config: string | Partial<SpawnConfig>) => {
    // Render the template with the SpawnConfig and send it as a prompt to the parent agent
    // The parent agent will then use its context to create a rich prompt and spawn via MCP
    if (typeof config === 'string') {
      // Simple string prompt (shouldn't happen from modal, but handle it)
      const metaPrompt = compiledSpawnSubsessionTemplate({ userPrompt: config });
      await onSendPrompt?.(metaPrompt, permissionMode);
    } else {
      // Full SpawnConfig from advanced modal - render template with all config
      const hasConfig =
        config.agent !== undefined ||
        config.permissionMode !== undefined ||
        config.modelConfig !== undefined ||
        config.codexSandboxMode !== undefined ||
        config.codexApprovalPolicy !== undefined ||
        config.codexNetworkAccess !== undefined ||
        (config.mcpServerIds?.length ?? 0) > 0 ||
        config.enableCallback !== undefined ||
        config.includeLastMessage !== undefined ||
        config.includeOriginalPrompt !== undefined ||
        config.extraInstructions !== undefined;

      // Import the full template compiler from ForkSpawnModal
      // (We'll use the same Handlebars instance)
      const Handlebars = await import('handlebars');

      // Register helper to check if value is defined (not undefined)
      // This allows us to distinguish between false and undefined
      Handlebars.registerHelper('isDefined', function (value) {
        return value !== undefined;
      });

      const compiledTemplate = Handlebars.compile(spawnSubsessionTemplate);

      const metaPrompt = compiledTemplate({
        userPrompt: config.prompt || '',
        hasConfig,
        agenticTool: config.agent,
        permissionMode: config.permissionMode,
        modelConfig: config.modelConfig,
        codexSandboxMode: config.codexSandboxMode,
        codexApprovalPolicy: config.codexApprovalPolicy,
        codexNetworkAccess: config.codexNetworkAccess,
        mcpServerIds: config.mcpServerIds,
        hasCallbackConfig:
          config.enableCallback !== undefined ||
          config.includeLastMessage !== undefined ||
          config.includeOriginalPrompt !== undefined,
        callbackConfig: {
          enableCallback: config.enableCallback,
          includeLastMessage: config.includeLastMessage,
          includeOriginalPrompt: config.includeOriginalPrompt,
        },
        extraInstructions: config.extraInstructions,
      });

      await onSendPrompt?.(metaPrompt, permissionMode);
    }

    setSpawnModalOpen(false);
    setInputValue(''); // Clear input after spawning
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
            ...session.permission_config?.codex,
            sandboxMode: sandbox,
            approvalPolicy: approval,
          },
        },
      });
    }
  };

  const handleThinkingModeChange = (newMode: 'auto' | 'manual' | 'off') => {
    setThinkingMode(newMode);

    // Persist to database immediately (will broadcast via WebSocket)
    if (session && onUpdateSession) {
      // Only update if model_config exists (has required fields)
      if (session.model_config) {
        onUpdateSession(session.session_id, {
          model_config: {
            ...session.model_config,
            thinkingMode: newMode,
          },
        });
      }
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
  const isRunning = session.status === SessionStatus.RUNNING;

  // Get repo from worktree (worktree is passed from parent)
  const repo = worktree ? repos.find((r) => r.repo_id === worktree.repo_id) : null;

  return (
    <Drawer
      title={
        <Space size={12} align="center">
          <ToolIcon tool={session.agentic_tool} size={40} />
          <div style={{ flex: 1 }}>
            <div style={{ marginBottom: 4 }}>
              <Typography.Text
                strong
                style={{
                  fontSize: 18,
                  display: '-webkit-box',
                  WebkitLineClamp: SESSION_TITLE_MAX_LINES,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                {(() => {
                  const displayText = session.title || session.description || session.agentic_tool;
                  // Fallback truncation for browsers that don't support line-clamp
                  if (
                    !session.title &&
                    session.description &&
                    session.description.length > SESSION_TITLE_FALLBACK_CHARS
                  ) {
                    return `${session.description.substring(0, SESSION_TITLE_FALLBACK_CHARS)}...`;
                  }
                  return displayText;
                })()}
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
                onClick={() => onOpenTerminal([`cd ${worktree.path}`], worktree.worktree_id)}
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
          overflow: 'hidden',
          background: token.colorBgElevated,
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
                onViewLogs={onViewLogs}
              />
            )}
            {/* Issue and PR Pills */}
            {worktree?.issue_url && <IssuePill issueUrl={worktree.issue_url} />}
            {worktree?.pull_request_url && <PullRequestPill prUrl={worktree.pull_request_url} />}
            {/* MCP Servers */}
            {sessionMcpServerIds
              .map((serverId) => mcpServers.find((s) => s.mcp_server_id === serverId))
              .filter(Boolean)
              .map((server) => (
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
      <ConversationView
        client={client}
        sessionId={session.session_id}
        agentic_tool={session.agentic_tool}
        sessionModel={session.model_config?.model}
        users={users}
        currentUserId={currentUserId}
        onScrollRef={setScrollToBottom}
        onPermissionDecision={onPermissionDecision}
        worktreeName={worktree?.name}
        scheduledFromWorktree={session.scheduled_from_worktree}
        scheduledRunAt={session.scheduled_run_at}
        isActive={open}
      />

      {/* Queued Messages Drawer - Above Footer */}
      {queuedMessages.length > 0 && (
        <div
          style={{
            flexShrink: 0,
            background: token.colorBgElevated,
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            borderTopLeftRadius: token.borderRadiusLG,
            borderTopRightRadius: token.borderRadiusLG,
            padding: `${token.sizeUnit * 3}px ${token.sizeUnit * 6}px`,
            marginLeft: -token.sizeUnit * 6 + token.sizeUnit * 2,
            marginRight: -token.sizeUnit * 6 + token.sizeUnit * 2,
            marginTop: token.sizeUnit * 2,
            boxShadow: `0 -2px 8px ${token.colorBgMask}`,
          }}
        >
          <Typography.Text
            type="secondary"
            style={{
              fontSize: token.fontSizeSM,
              display: 'block',
              marginBottom: token.sizeUnit * 2,
              fontWeight: 500,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}
          >
            Queued Messages ({queuedMessages.length})
          </Typography.Text>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {queuedMessages.map((msg, idx) => (
              <div
                key={msg.message_id}
                style={{
                  background: token.colorBgContainer,
                  padding: `${token.sizeUnit * 2}px ${token.sizeUnit * 3}px`,
                  borderRadius: token.borderRadius,
                  border: `1px solid ${token.colorBorder}`,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: token.sizeUnit * 2,
                }}
              >
                <Typography.Text ellipsis style={{ flex: 1 }}>
                  <span style={{ color: token.colorTextSecondary, marginRight: token.sizeUnit }}>
                    {idx + 1}.
                  </span>
                  {msg.content_preview || (typeof msg.content === 'string' ? msg.content : '')}
                </Typography.Text>
                <Space size={4}>
                  <Button
                    type="text"
                    size="small"
                    icon={<CopyOutlined />}
                    onClick={() => {
                      const textToCopy =
                        msg.content_preview || (typeof msg.content === 'string' ? msg.content : '');
                      navigator.clipboard.writeText(textToCopy);
                      message.success('Message copied to clipboard');
                    }}
                  />
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={async () => {
                      if (!client) return;

                      try {
                        console.log('[SessionDrawer] DELETE attempt:', {
                          sessionId: session.session_id,
                          messageId: msg.message_id,
                        });

                        // Optimistically remove from UI
                        setQueuedMessages((prev) =>
                          prev.filter((m) => m.message_id !== msg.message_id)
                        );

                        // Delete via messages service directly
                        // The backend will validate it's a queued message
                        const result = await client.service('messages').remove(msg.message_id);

                        console.log('[SessionDrawer] DELETE success:', result);
                      } catch (error) {
                        console.error('[SessionDrawer] DELETE error:', {
                          error,
                          errorType: error?.constructor?.name,
                          errorMessage: error instanceof Error ? error.message : String(error),
                          errorStack: error instanceof Error ? error.stack : undefined,
                        });
                        message.error(
                          `Failed to remove queued message: ${error instanceof Error ? error.message : String(error)}`
                        );

                        // Re-fetch queue to restore accurate state
                        const response = await client
                          .service(`sessions/${session.session_id}/messages/queue`)
                          .find();
                        const data = (response as { data: Message[] }).data || [];
                        setQueuedMessages(data);
                      }
                    }}
                  />
                </Space>
              </div>
            ))}
          </Space>
        </div>
      )}

      {/* Input Box Footer */}
      <div
        style={{
          position: 'relative',
          flexShrink: 0,
          background: token.colorBgContainer,
          borderTop: `1px solid ${token.colorBorder}`,
          padding: `${token.sizeUnit * 2}px ${token.sizeUnit * 6}px ${token.sizeUnit * 3}px`,
          marginLeft: -token.sizeUnit * 6,
          marginRight: -token.sizeUnit * 6,
        }}
      >
        {/* Context window gradient overlay */}
        {footerGradient && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: footerGradient,
              pointerEvents: 'none',
              zIndex: 0,
            }}
          />
        )}
        <Space
          direction="vertical"
          style={{ width: '100%', position: 'relative', zIndex: 1 }}
          size={8}
        >
          <AutocompleteTextarea
            value={inputValue}
            onChange={setInputValue}
            placeholder="Send a prompt, fork, or create a subsession... (type @ for autocomplete)"
            autoSize={{ minRows: 1, maxRows: 10 }}
            onKeyPress={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                // Allow sending/queueing when there's input (queues if running, sends if idle)
                if (inputValue.trim()) {
                  handleSendPrompt();
                }
              }
            }}
            client={client}
            sessionId={session?.session_id || null}
            users={users}
          />
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Space size={0}>
              {footerTimerTask && (
                <TimerPill
                  status={footerTimerTask.status}
                  startedAt={
                    footerTimerTask.message_range?.start_timestamp || footerTimerTask.created_at
                  }
                  endedAt={
                    footerTimerTask.message_range?.end_timestamp || footerTimerTask.completed_at
                  }
                  durationMs={footerTimerTask.duration_ms}
                  tooltip={
                    footerTimerTask.status === TaskStatus.RUNNING
                      ? 'Active task runtime'
                      : 'Last task duration'
                  }
                />
              )}
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
                  taskMetadata={latestContextWindow.taskMetadata}
                />
              )}
            </Space>
            <Space size={4}>
              {/* Thinking Mode Selector - Claude only */}
              {session.agentic_tool === 'claude-code' && (
                <ThinkingModeSelector
                  value={thinkingMode}
                  onChange={handleThinkingModeChange}
                  size="small"
                  compact
                />
              )}
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
                <Tooltip title="Advanced Spawn Options">
                  <Button
                    icon={<SettingOutlined />}
                    onClick={() => setSpawnModalOpen(true)}
                    disabled={connectionDisabled || isRunning || !inputValue.trim()}
                  />
                </Tooltip>
                <Tooltip title={isRunning ? 'Session is running...' : 'Fork Session'}>
                  <Button
                    icon={<ForkOutlined />}
                    onClick={handleFork}
                    disabled={connectionDisabled || isRunning || !inputValue.trim()}
                  />
                </Tooltip>
                <Tooltip title={isRunning ? 'Session is running...' : 'Spawn Subsession'}>
                  <Button
                    icon={<BranchesOutlined />}
                    onClick={handleSubsession}
                    disabled={connectionDisabled || isRunning || !inputValue.trim()}
                  />
                </Tooltip>
                <Tooltip title={isRunning ? 'Queue Message' : 'Send Prompt'}>
                  <Button
                    type="primary"
                    icon={<SendOutlined />}
                    onClick={handleSendPrompt}
                    disabled={connectionDisabled || !inputValue.trim()}
                  />
                </Tooltip>
              </Space.Compact>
            </Space>
          </Space>
        </Space>
      </div>

      {/* Advanced Spawn Modal */}
      <ForkSpawnModal
        open={spawnModalOpen}
        action="spawn"
        session={session}
        currentUser={users.find((u) => u.user_id === currentUserId)}
        mcpServers={mcpServers}
        initialPrompt={inputValue}
        onConfirm={handleSpawnModalConfirm}
        onCancel={() => setSpawnModalOpen(false)}
      />
    </Drawer>
  );
};

export default SessionDrawer;
