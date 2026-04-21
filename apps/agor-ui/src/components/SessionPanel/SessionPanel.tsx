import type {
  AgorClient,
  CodexApprovalPolicy,
  CodexSandboxMode,
  EffortLevel,
  Message,
  PermissionMode,
  Session,
  SessionID,
  SpawnConfig,
  User,
  Worktree,
} from '@agor-live/client';
import { AGENTIC_TOOL_CAPABILITIES, SessionStatus, TaskStatus } from '@agor-live/client';
import {
  BranchesOutlined,
  CloseOutlined,
  CodeOutlined,
  DeleteOutlined,
  ForkOutlined,
  QuestionCircleOutlined,
  SendOutlined,
  SettingOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { Alert, App, Badge, Button, Space, Spin, Tooltip, Typography, theme } from 'antd';
import Handlebars from 'handlebars';
import React from 'react';
import { getDaemonUrl } from '../../config/daemon';
import { useAppActions } from '../../contexts/AppActionsContext';
import { useAppData } from '../../contexts/AppDataContext';
import { useConnectionDisabled } from '../../contexts/ConnectionContext';
import { useSharedReactiveSession } from '../../hooks/useSharedReactiveSession';
import spawnSubsessionTemplate from '../../templates/spawn_subsession.hbs?raw';
import { getContextWindowGradient } from '../../utils/contextWindow';
import { mcpServerNeedsAuth } from '../../utils/mcpAuth';
import { getSessionDisplayTitle, getSessionTitleStyles } from '../../utils/sessionTitle';
import { compileTemplate } from '../../utils/templates';
import { AutocompleteTextarea } from '../AutocompleteTextarea';
import { EffortSelector } from '../EffortSelector';
import { FileUpload, FileUploadButton } from '../FileUpload';
import { MCPServerPill } from '../MCPServerPill';
import { CreatedByTag } from '../metadata';
import { PermissionModeSelector } from '../PermissionModeSelector';
import { ContextWindowPill, ModelPill, SessionIdPill, TimerPill, TokenCountPill } from '../Pill';
import { ToolIcon } from '../ToolIcon';
import { SessionPanelContent } from './SessionPanelContent';

// Register helper to check if value is defined (not undefined)
// This allows us to distinguish between false and undefined in templates
Handlebars.registerHelper('isDefined', (value: unknown) => value !== undefined);

// Re-export PermissionMode from SDK for convenience
export type { PermissionMode };

/** Context shape for the spawn subsession Handlebars template */
interface SpawnTemplateContext {
  userPrompt: string;
  hasConfig?: boolean;
  agenticTool?: string;
  permissionMode?: PermissionMode;
  modelConfig?: SpawnConfig['modelConfig'];
  codexSandboxMode?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexNetworkAccess?: boolean;
  mcpServerIds?: string[];
  hasCallbackConfig?: boolean;
  callbackConfig?: {
    enableCallback?: boolean;
    includeLastMessage?: boolean;
    includeOriginalPrompt?: boolean;
  };
  extraInstructions?: string;
}

// Compile the spawn subsession template once at module level (after helper registration)
const compiledSpawnSubsessionTemplate =
  compileTemplate<SpawnTemplateContext>(spawnSubsessionTemplate);

// ---------------------------------------------------------------------------
// PromptInput — thin wrapper around AutocompleteTextarea that keeps the typed
// text in *local* state so that keystrokes never trigger a parent re-render.
// The parent reads/clears the value imperatively via a ref.
// ---------------------------------------------------------------------------

export interface PromptInputHandle {
  getValue: () => string;
  clear: () => void;
  insertText: (text: string) => void;
}

interface PromptInputProps {
  sessionId: SessionID;
  getDraft: (id: string) => string;
  saveDraft: (id: string, value: string) => void;
  deleteDraft: (id: string) => void;
  /** Fires only on empty↔non-empty transitions, not every keystroke */
  onHasInputChange: (hasInput: boolean) => void;
  /** Kept in sync so memoized children can read the latest value */
  inputValueRef: React.MutableRefObject<string>;
  /** Called on Enter (without Shift) when there is non-empty text */
  onSubmit: () => void;
  // Forwarded to AutocompleteTextarea
  placeholder?: string;
  autoSize?: { minRows?: number; maxRows?: number };
  client: AgorClient | null;
  userById: Map<string, User>;
  onFilesDrop?: (files: File[]) => void;
  slashCommands?: string[];
  skills?: string[];
}

const PromptInput = React.forwardRef<PromptInputHandle, PromptInputProps>(
  (
    {
      sessionId,
      getDraft,
      saveDraft,
      deleteDraft,
      onHasInputChange,
      inputValueRef,
      onSubmit,
      placeholder,
      autoSize,
      client,
      userById,
      onFilesDrop,
      slashCommands,
      skills,
    },
    ref
  ) => {
    const [value, setValue] = React.useState(() => getDraft(sessionId));
    const valueRef = React.useRef(value);

    // Keep refs in sync (zero-cost, no re-render)
    valueRef.current = value;
    inputValueRef.current = value;

    // Track empty↔non-empty transitions → notify parent (minimal re-renders)
    const prevHasInput = React.useRef(!!value.trim());
    React.useEffect(() => {
      const has = !!value.trim();
      if (has !== prevHasInput.current) {
        prevHasInput.current = has;
        onHasInputChange(has);
      }
    }, [value, onHasInputChange]);

    // Imperative methods for the parent
    React.useImperativeHandle(
      ref,
      () => ({
        getValue: () => valueRef.current,
        clear: () => {
          setValue('');
          deleteDraft(sessionId);
        },
        insertText: (text: string) => {
          setValue((prev) => {
            const trimmed = prev.trim();
            const separator = trimmed ? ' ' : '';
            return `${trimmed}${separator}${text}`;
          });
        },
      }),
      [sessionId, deleteDraft]
    );

    // Session switch: save old draft, load new one
    const prevSessionId = React.useRef(sessionId);
    React.useEffect(() => {
      if (prevSessionId.current !== sessionId) {
        saveDraft(prevSessionId.current, valueRef.current);
        setValue(getDraft(sessionId));
        prevSessionId.current = sessionId;
      }
    }, [sessionId, saveDraft, getDraft]);

    // Debounced draft persistence (300ms)
    React.useEffect(() => {
      const timer = setTimeout(() => saveDraft(sessionId, value), 300);
      return () => clearTimeout(timer);
    }, [value, sessionId, saveDraft]);

    // Flush draft on unmount so in-flight debounced writes aren't lost.
    // Uses refs to capture the latest values without adding deps that would
    // cause the effect to re-run (we only want the cleanup to fire on unmount).
    const saveDraftRef = React.useRef(saveDraft);
    saveDraftRef.current = saveDraft;
    const sessionIdRef = React.useRef(sessionId);
    sessionIdRef.current = sessionId;
    React.useEffect(() => {
      return () => saveDraftRef.current(sessionIdRef.current, valueRef.current);
    }, []);

    const handleKeyPress = React.useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (valueRef.current.trim()) {
            onSubmit();
          }
        }
      },
      [onSubmit]
    );

    return (
      <AutocompleteTextarea
        value={value}
        onChange={setValue}
        placeholder={placeholder}
        autoSize={autoSize}
        onKeyPress={handleKeyPress}
        client={client}
        sessionId={sessionId}
        userById={userById}
        onFilesDrop={onFilesDrop}
        slashCommands={slashCommands}
        skills={skills}
      />
    );
  }
);

PromptInput.displayName = 'PromptInput';

// ---------------------------------------------------------------------------

export interface SessionPanelProps {
  client: AgorClient | null;
  session: Session | null;
  worktree?: Worktree | null;
  currentUserId?: string;
  sessionMcpServerIds?: string[];
  open: boolean;
  onClose: () => void;
}

const SessionPanel: React.FC<SessionPanelProps> = ({
  client,
  session,
  worktree = null,
  currentUserId,
  sessionMcpServerIds = [],
  open,
  onClose,
}) => {
  const { token } = theme.useToken();
  const { modal, message } = App.useApp();
  const connectionDisabled = useConnectionDisabled();

  // Get data from context
  const { userById, mcpServerById, userAuthenticatedMcpServerIds } = useAppData();

  // Get actions from context
  const {
    onSendPrompt,
    onFork,
    onBtwFork,
    onOpenSettings,
    onUpdateSession,
    onDeleteSession: onDelete,
    onOpenTerminal,
  } = useAppActions();

  // Tool capabilities — drives which buttons are shown
  const toolCaps = session?.agentic_tool
    ? AGENTIC_TOOL_CAPABILITIES[session.agentic_tool]
    : undefined;

  // Compute which session MCP servers need authentication
  const unauthedMcpServers = React.useMemo(() => {
    return sessionMcpServerIds
      .map((id) => mcpServerById.get(id))
      .filter((server) => mcpServerNeedsAuth(server, userAuthenticatedMcpServerIds))
      .map((server) => server!);
  }, [sessionMcpServerIds, mcpServerById, userAuthenticatedMcpServerIds]);

  // Per-session draft storage (localStorage-backed to survive unmounts)
  const DRAFT_KEY_PREFIX = 'agor-draft-';
  const getDraft = React.useCallback((sessionId: string): string => {
    try {
      return localStorage.getItem(`${DRAFT_KEY_PREFIX}${sessionId}`) || '';
    } catch {
      return '';
    }
  }, []);
  const saveDraft = React.useCallback((sessionId: string, value: string) => {
    try {
      if (value.trim()) {
        localStorage.setItem(`${DRAFT_KEY_PREFIX}${sessionId}`, value);
      } else {
        localStorage.removeItem(`${DRAFT_KEY_PREFIX}${sessionId}`);
      }
    } catch {
      // localStorage full or unavailable
    }
  }, []);
  const deleteDraft = React.useCallback((sessionId: string) => {
    try {
      localStorage.removeItem(`${DRAFT_KEY_PREFIX}${sessionId}`);
    } catch {
      // ignore
    }
  }, []);

  // Input value lives entirely inside PromptInput (local state).
  // The parent reads it imperatively via promptRef / inputValueRef — no
  // parent re-renders on keystrokes.
  const promptRef = React.useRef<PromptInputHandle>(null);
  const inputValueRef = React.useRef(session ? getDraft(session.session_id) : '');
  const [hasInput, setHasInput] = React.useState(() => !!inputValueRef.current.trim());
  const handleHasInputChange = React.useCallback((v: boolean) => setHasInput(v), []);

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
  const [effortLevel, setEffortLevel] = React.useState<EffortLevel>(
    session?.model_config?.effort || 'high'
  );
  const [scrollToBottom, setScrollToBottom] = React.useState<(() => void) | null>(null);
  const [scrollToTop, setScrollToTop] = React.useState<(() => void) | null>(null);
  const [queuedMessages, setQueuedMessages] = React.useState<Message[]>([]);
  const [spawnModalOpen, setSpawnModalOpen] = React.useState(false);
  const [uploadModalOpen, setUploadModalOpen] = React.useState(false);
  const [droppedFiles, setDroppedFiles] = React.useState<File[]>([]);
  const [stopRequestInFlight, setStopRequestInFlight] = React.useState(false);
  const reactiveSessionId = session?.session_id ?? null;
  const { state: reactiveSessionState } = useSharedReactiveSession(client, reactiveSessionId, {
    enabled: open,
    reactiveOptions: { taskHydration: 'none' },
  });

  const tasks = reactiveSessionState?.tasks || [];

  // Fetch queued messages
  React.useEffect(() => {
    if (!client || !session) return;

    const fetchQueue = async () => {
      try {
        const response = await client
          .service(`/sessions/${session.session_id}/messages/queue`)
          .find();
        const data = (response as { data: Message[] }).data || [];
        setQueuedMessages(data);
      } catch (error) {
        console.error('[SessionPanel] Failed to fetch queue:', error);
      }
    };

    fetchQueue();

    const messagesService = client.service('messages');

    const handleQueued = (msg: Message) => {
      if (msg.session_id === session.session_id) {
        setQueuedMessages((prev) => {
          // Deduplicate: optimistic update from enqueue may have already added this message
          if (prev.some((m) => m.message_id === msg.message_id)) return prev;
          return [...prev, msg].sort((a, b) => (a.queue_position ?? 0) - (b.queue_position ?? 0));
        });
      }
    };

    const handleMessageRemoved = (msg: Message) => {
      if (msg.status === 'queued' && msg.session_id === session.session_id) {
        setQueuedMessages((prev) => prev.filter((m) => m.message_id !== msg.message_id));
      }
    };

    messagesService.on('queued', handleQueued);
    messagesService.on('removed', handleMessageRemoved);

    return () => {
      messagesService.off('queued', handleQueued);
      messagesService.off('removed', handleMessageRemoved);
    };
  }, [client, session]);

  // Token breakdown calculation
  const tokenBreakdown = React.useMemo(() => {
    if (!session?.agentic_tool) {
      return { total: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 };
    }

    return tasks.reduce(
      (acc, task) => {
        if (!task.normalized_sdk_response) return acc;

        const { tokenUsage, costUsd } = task.normalized_sdk_response;

        return {
          total: acc.total + tokenUsage.totalTokens,
          input: acc.input + tokenUsage.inputTokens,
          output: acc.output + tokenUsage.outputTokens,
          cacheRead: acc.cacheRead + (tokenUsage.cacheReadTokens || 0),
          cacheCreation: acc.cacheCreation + (tokenUsage.cacheCreationTokens || 0),
          cost: acc.cost + (costUsd || 0),
        };
      },
      { total: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 }
    );
  }, [tasks, session?.agentic_tool]);

  // Get latest context window
  const latestContextWindow = React.useMemo(() => {
    if (!session?.agentic_tool) return null;

    for (let i = tasks.length - 1; i >= 0; i--) {
      const task = tasks[i];
      if (task.computed_context_window !== undefined && task.normalized_sdk_response) {
        const { contextWindowLimit } = task.normalized_sdk_response;

        if (task.computed_context_window > 0) {
          return {
            used: task.computed_context_window,
            limit: contextWindowLimit || 0,
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

  const footerGradient = React.useMemo(() => {
    if (!latestContextWindow) return undefined;
    return getContextWindowGradient(latestContextWindow.used, latestContextWindow.limit);
  }, [latestContextWindow]);

  const footerTimerTask = React.useMemo(() => {
    if (tasks.length === 0) return null;

    for (let index = tasks.length - 1; index >= 0; index -= 1) {
      const candidate = tasks[index];
      if (
        candidate.status === TaskStatus.RUNNING ||
        candidate.status === TaskStatus.STOPPING ||
        candidate.status === TaskStatus.AWAITING_PERMISSION ||
        candidate.status === TaskStatus.AWAITING_INPUT
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
      setPermissionMode(getDefaultPermissionMode(session.agentic_tool));
    }

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

  // Update effort level when session changes (default to 'high' for sessions without effort config)
  React.useEffect(() => {
    setEffortLevel(session?.model_config?.effort || 'high');
  }, [session?.model_config?.effort]);

  // Scroll to bottom when panel opens or session changes
  React.useEffect(() => {
    if (open && scrollToBottom && session) {
      const timeoutId = setTimeout(() => {
        scrollToBottom();
      }, 300);
      return () => clearTimeout(timeoutId);
    }
  }, [open, scrollToBottom, session]);

  // When there's no session, render nothing (panel is collapsed to zero).
  // When open=false, we still render the component tree (hidden) so that
  // antd's CSS-in-JS doesn't garbage-collect component styles.
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
        onClose();
      },
    });
  };

  const isRunning =
    session.status === SessionStatus.RUNNING || session.status === SessionStatus.STOPPING;
  const isStopping = session.status === SessionStatus.STOPPING;

  const handleSendPrompt = async () => {
    const value = promptRef.current?.getValue() ?? '';
    if (!value.trim() || connectionDisabled) return;

    const promptToSend = value.trim();

    try {
      if (isRunning && client) {
        const response = (await client
          .service(`/sessions/${session.session_id}/messages/queue`)
          .create({
            prompt: promptToSend,
          })) as { success: boolean; message: Message; queue_position: number };

        if (response.message) {
          setQueuedMessages((prev) => {
            if (prev.some((m) => m.message_id === response.message.message_id)) return prev;
            return [...prev, response.message].sort(
              (a, b) => (a.queue_position ?? 0) - (b.queue_position ?? 0)
            );
          });
        }

        message.success(`Message queued at position ${response.message.queue_position}`);
        promptRef.current?.clear();
      } else {
        promptRef.current?.clear();
        onSendPrompt?.(session.session_id, promptToSend, permissionMode);
      }
    } catch (error) {
      message.error(
        `Failed to ${isRunning ? 'queue' : 'send'} message: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const handleStop = async () => {
    if (!session || !client || stopRequestInFlight) return;

    // Show feedback immediately if this is a retry
    if (isStopping) {
      message.info('Retrying stop request...');
    }

    setStopRequestInFlight(true);
    try {
      await client.service(`sessions/${session.session_id}/stop`).create({});
    } catch (error) {
      console.error('Failed to stop execution:', error);
      message.error('Failed to stop execution. You can try again.');
    } finally {
      setStopRequestInFlight(false);
    }
  };

  const handleFork = async () => {
    if (!session) return;
    const value = promptRef.current?.getValue() ?? '';
    const promptToSend = value.trim();
    if (!promptToSend) return;
    try {
      await onFork?.(session.session_id, promptToSend);
      // Only clear the compose box + draft on success, so a failed fork
      // leaves the typed prompt intact for the user to retry.
      promptRef.current?.clear();
    } catch (error) {
      console.error('Fork failed — keeping prompt in compose box:', error);
    }
  };

  const handleBtwSend = async () => {
    const value = promptRef.current?.getValue() ?? '';
    if (!value.trim() || connectionDisabled) return;
    const promptToSend = value.trim();
    try {
      await onBtwFork?.(session.session_id, promptToSend);
      promptRef.current?.clear();
    } catch (error) {
      console.error('BTW fork failed — keeping prompt in compose box:', error);
    }
  };

  const handleSpawnModalConfirm = async (config: string | Partial<SpawnConfig>) => {
    if (!session) return;

    if (typeof config === 'string') {
      const metaPrompt = compiledSpawnSubsessionTemplate({ userPrompt: config });
      await onSendPrompt?.(session.session_id, metaPrompt, permissionMode);
    } else {
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

      const metaPrompt = compiledSpawnSubsessionTemplate({
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

      await onSendPrompt?.(session.session_id, metaPrompt, permissionMode);
    }

    setSpawnModalOpen(false);
    promptRef.current?.clear();
  };

  const handlePermissionModeChange = (newMode: PermissionMode) => {
    setPermissionMode(newMode);

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

  const handleEffortChange = (newEffort: EffortLevel) => {
    setEffortLevel(newEffort);

    if (session && onUpdateSession) {
      if (session.model_config) {
        onUpdateSession(session.session_id, {
          model_config: {
            ...session.model_config,
            effort: newEffort,
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
      case 'timed_out':
        return 'warning';
      default:
        return 'default';
    }
  };

  // Footer controls
  const footerControls = (
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
        orientation="vertical"
        style={{ width: '100%', position: 'relative', zIndex: 1 }}
        size={8}
      >
        {unauthedMcpServers.length > 0 && (
          <Alert
            type="warning"
            showIcon
            message={
              <span>
                {unauthedMcpServers.map((server) => (
                  <MCPServerPill
                    key={server.mcp_server_id}
                    server={server}
                    needsAuth
                    client={client}
                  />
                ))}{' '}
                not authenticated — click to sign in.
              </span>
            }
            style={{ marginBottom: 0 }}
            banner
          />
        )}
        <PromptInput
          ref={promptRef}
          sessionId={session.session_id}
          getDraft={getDraft}
          saveDraft={saveDraft}
          deleteDraft={deleteDraft}
          onHasInputChange={handleHasInputChange}
          inputValueRef={inputValueRef}
          onSubmit={handleSendPrompt}
          placeholder={
            isRunning
              ? 'Session is working... Type here to queue, or use "btw" for a side question'
              : 'Send a prompt, fork, or use "btw" for a side question... (type @ for autocomplete)'
          }
          autoSize={{ minRows: 1, maxRows: 10 }}
          client={client}
          userById={userById}
          onFilesDrop={(files) => {
            // Store dropped files and open modal
            setDroppedFiles(files);
            setUploadModalOpen(true);
          }}
          slashCommands={(() => {
            const ctx = session?.custom_context as Record<string, unknown> | undefined;
            return Array.isArray(ctx?.slash_commands) ? ctx.slash_commands : undefined;
          })()}
          skills={(() => {
            const ctx = session?.custom_context as Record<string, unknown> | undefined;
            return Array.isArray(ctx?.skills) ? ctx.skills : undefined;
          })()}
        />
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: `${token.sizeUnit}px`,
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Space size={4} wrap>
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
              />
            )}
            <SessionIdPill
              sessionId={session.session_id}
              sdkSessionId={session.sdk_session_id}
              agenticTool={session.agentic_tool}
              showCopy={true}
            />
            {session.model_config?.model && (
              <ModelPill
                model={
                  session.agentic_tool === 'opencode' &&
                  session.model_config.provider &&
                  session.model_config.model
                    ? `${session.model_config.provider}/${session.model_config.model}`
                    : session.model_config.model
                }
              />
            )}
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
          <Space size={4} wrap style={{ marginLeft: 'auto' }}>
            {session.agentic_tool === 'claude-code' && (
              <EffortSelector
                value={effortLevel}
                onChange={handleEffortChange}
                size="small"
                compact
              />
            )}
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
                  stopRequestInFlight
                    ? 'Sending stop request...'
                    : isStopping
                      ? 'Stopping... (Click again to retry if stuck)'
                      : isRunning
                        ? 'Stop Execution'
                        : 'No active execution'
                }
              >
                <Button
                  danger
                  icon={<StopOutlined />}
                  onClick={handleStop}
                  disabled={!isRunning || stopRequestInFlight}
                  loading={isStopping && !stopRequestInFlight}
                />
              </Tooltip>
              {toolCaps?.supportsSessionFork !== false && (
                <Tooltip title={connectionDisabled ? 'Disconnected from daemon' : 'Fork Session'}>
                  <Button
                    icon={<ForkOutlined />}
                    onClick={handleFork}
                    disabled={connectionDisabled}
                  />
                </Tooltip>
              )}
              {toolCaps?.supportsChildSpawn !== false && (
                <Tooltip
                  title={
                    connectionDisabled
                      ? 'Disconnected from daemon'
                      : isRunning
                        ? 'Session is running...'
                        : 'Spawn Subsession'
                  }
                >
                  <Button
                    icon={<BranchesOutlined />}
                    onClick={() => setSpawnModalOpen(true)}
                    disabled={connectionDisabled || isRunning}
                  />
                </Tooltip>
              )}
              {toolCaps?.supportsSessionFork !== false && (
                <Tooltip title="Ask a side question via ephemeral fork (btw)">
                  <Button
                    icon={<QuestionCircleOutlined />}
                    onClick={handleBtwSend}
                    disabled={connectionDisabled}
                  />
                </Tooltip>
              )}
              <Tooltip title={connectionDisabled ? 'Disconnected from daemon' : 'Upload Files'}>
                <FileUploadButton
                  onClick={() => setUploadModalOpen(true)}
                  disabled={connectionDisabled}
                />
              </Tooltip>
              <Tooltip
                title={
                  connectionDisabled
                    ? 'Disconnected from daemon'
                    : isRunning
                      ? 'Queue Message'
                      : 'Send Prompt'
                }
              >
                <Button
                  type="primary"
                  icon={<SendOutlined />}
                  onClick={handleSendPrompt}
                  disabled={connectionDisabled || !hasInput}
                />
              </Tooltip>
            </Space.Compact>
          </Space>
        </div>
      </Space>
    </div>
  );

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: open ? 'flex' : 'none',
        flexDirection: 'column',
        background: token.colorBgElevated,
        borderLeft: `1px solid ${token.colorBorder}`,
      }}
    >
      {/* Header */}
      <div
        style={{
          flexShrink: 0,
          padding: `${token.sizeUnit * 3}px ${token.sizeUnit * 6}px`,
          borderBottom: `1px solid ${token.colorBorder}`,
          background: token.colorBgContainer,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <Space size={12} align="start" style={{ flex: 1 }}>
            <ToolIcon tool={session.agentic_tool} size={40} />
            <div style={{ flex: 1 }}>
              <div style={{ marginBottom: 4 }}>
                <Typography.Text
                  strong
                  style={{
                    fontSize: 18,
                    ...getSessionTitleStyles(2),
                  }}
                >
                  {getSessionDisplayTitle(session, { includeAgentFallback: true })}
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
                    userById={userById}
                    prefix="Created by"
                  />
                </div>
              )}
            </div>
          </Space>
          <Space size={4}>
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
            {onDelete && (
              <Tooltip title="Delete Session">
                <Button type="text" danger icon={<DeleteOutlined />} onClick={handleDelete} />
              </Tooltip>
            )}
            <Tooltip title="Close Panel">
              <Button
                type="text"
                icon={<CloseOutlined />}
                onClick={onClose}
                style={{ marginLeft: token.sizeUnit }}
              />
            </Tooltip>
          </Space>
        </div>
      </div>

      {/* Body - Scrollable content */}
      <div
        style={{
          flex: 1,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          padding: `${token.sizeUnit * 3}px ${token.sizeUnit * 6}px 0`,
        }}
      >
        <SessionPanelContent
          client={client}
          session={session}
          worktree={worktree}
          currentUserId={currentUserId}
          sessionMcpServerIds={sessionMcpServerIds}
          scrollToBottom={scrollToBottom}
          scrollToTop={scrollToTop}
          setScrollToBottom={setScrollToBottom}
          setScrollToTop={setScrollToTop}
          queuedMessages={queuedMessages}
          setQueuedMessages={setQueuedMessages}
          spawnModalOpen={spawnModalOpen}
          setSpawnModalOpen={setSpawnModalOpen}
          onSpawnModalConfirm={handleSpawnModalConfirm}
          inputValueRef={inputValueRef}
          isOpen={open}
        />

        {/* Footer Controls — rendered outside SessionPanelContent so that
            keystroke-driven re-renders don't propagate to ConversationView */}
        {footerControls}

        {/* File upload modal */}
        {session && (
          <FileUpload
            sessionId={session.session_id}
            daemonUrl={getDaemonUrl()}
            open={uploadModalOpen}
            onClose={() => {
              setUploadModalOpen(false);
              setDroppedFiles([]); // Clear dropped files when modal closes
            }}
            initialFiles={droppedFiles}
            onUploadComplete={(files) => {
              message.success(`Uploaded ${files.length} file(s)`);
            }}
            onInsertMention={(filepath) => {
              // Insert @filepath mention into the textarea
              promptRef.current?.insertText(`@${filepath}`);
            }}
          />
        )}
      </div>
    </div>
  );
};

export default SessionPanel;
