import type {
  AgorClient,
  Branch,
  CodexApprovalPolicy,
  CodexSandboxMode,
  EffortLevel,
  Link,
  PermissionMode,
  Session,
  SessionID,
  SpawnConfig,
  Task,
  User,
} from '@agor-live/client';
import {
  AGENTIC_TOOL_CAPABILITIES,
  getDefaultPermissionMode,
  mapToCodexPermissionConfig,
  SessionStatus,
  TaskStatus,
} from '@agor-live/client';
import {
  AimOutlined,
  CloseOutlined,
  CodeOutlined,
  DownOutlined,
  EllipsisOutlined,
  InboxOutlined,
  SearchOutlined,
  SettingOutlined,
  UpOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import {
  Alert,
  App,
  Badge,
  Button,
  Dropdown,
  Input,
  Space,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import React from 'react';
import { getDaemonUrl } from '../../config/daemon';
import { useAppActions } from '../../contexts/AppActionsContext';
import { useRecenterMap } from '../../contexts/CanvasNavigationContext';
import { useConnectionDisabled } from '../../contexts/ConnectionContext';
import { useSessionActions } from '../../hooks/useSessionActions';
import { useSessionSearch } from '../../hooks/useSessionSearch';
import { useSharedReactiveSession } from '../../hooks/useSharedReactiveSession';
import { useAgorStore } from '../../store/agorStore';
import {
  makeLinksForBranchSelector,
  makeLinksForSessionSelector,
  selectBoardById,
  selectFetchAndReplaceFullBranchLinks,
  selectFetchAndReplaceFullSessionLinks,
  selectMcpServerById,
  selectUserAuthenticatedMcpServerIds,
  selectUserById,
} from '../../store/selectors';
import { getContextWindowGradient } from '../../utils/contextWindow';
import { mcpServerNeedsAuth } from '../../utils/mcpAuth';
import { useThemedMessage } from '../../utils/message';
import { getSessionDisplayTitle, getSessionTitleStyles } from '../../utils/sessionTitle';
import { AutocompleteTextarea } from '../AutocompleteTextarea';
import { FileUpload } from '../FileUpload';
import { ForkSpawnModal } from '../ForkSpawnModal/ForkSpawnModal';
import {
  buildLinkDisplayItems,
  getTeammatePromotionState,
  getTeammatePromotionUnavailableReason,
  groupRenderableLinksByMessageId,
  type LinkDisplayItem,
  selectPinnedLinkDisplayItems,
  useLinkMutations,
} from '../Links';
import type { ModelConfig } from '../ModelSelector';
import { CreatedByTag } from '../metadata';
import { ToolIcon } from '../ToolIcon';
import {
  buildPromptWithAttachments,
  getComposerUploadAccept,
  isBlockingComposerAttachment,
} from './composerAttachments';
import { SessionAttachmentsDropdown } from './SessionAttachmentsDropdown';
import { SessionAttachmentTray } from './SessionAttachmentTray';
import { SessionComposerDropZone } from './SessionComposerDropZone';
import { SessionFooter } from './SessionFooter';
import { SessionPanelContent } from './SessionPanelContent';
import { useComposerAttachments } from './useComposerAttachments';

// Re-export PermissionMode from SDK for convenience
export type { PermissionMode };

// The find shortcut is Cmd+F on mac, Ctrl+F elsewhere — label it correctly.
const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform ?? '');
const FIND_SHORTCUT_LABEL = IS_MAC ? 'Cmd+F' : 'Ctrl+F';

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
  /** Called on Enter (without Shift) when there is sendable composer content */
  onSubmit: () => void;
  hasExternalInput?: boolean;
  disabled?: boolean;
  mutationLockedRef?: React.RefObject<boolean>;
  // Forwarded to AutocompleteTextarea
  placeholder?: string;
  autoSize?: { minRows?: number; maxRows?: number };
  client: AgorClient | null;
  userById: Map<string, User>;
  onFilesDrop?: (files: File[]) => void;
  filesDropDisabled?: boolean;
  showFilesDropOverlay?: boolean;
  suppressEmptyHighlight?: boolean;
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
      hasExternalInput = false,
      disabled = false,
      mutationLockedRef,
      placeholder,
      autoSize,
      client,
      userById,
      onFilesDrop,
      filesDropDisabled = false,
      showFilesDropOverlay = true,
      suppressEmptyHighlight = false,
      slashCommands,
      skills,
    },
    ref
  ) => {
    const [value, setValue] = React.useState(() => getDraft(sessionId));
    const valueRef = React.useRef(value);
    const textareaElementRef = React.useRef<HTMLTextAreaElement | null>(null);

    // Keep refs in sync (zero-cost, no re-render)
    valueRef.current = value;
    inputValueRef.current = value;

    const handlePromptChange = React.useCallback(
      (nextValue: string) => {
        if (disabled || mutationLockedRef?.current) return;
        valueRef.current = nextValue;
        inputValueRef.current = nextValue;
        setValue(nextValue);
      },
      [disabled, inputValueRef, mutationLockedRef]
    );

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
        getValue: () => textareaElementRef.current?.value ?? valueRef.current,
        clear: () => {
          valueRef.current = '';
          inputValueRef.current = '';
          if (textareaElementRef.current) {
            textareaElementRef.current.value = '';
          }
          setValue('');
          deleteDraft(sessionId);
        },
        insertText: (text: string) => {
          if (disabled || mutationLockedRef?.current) return;
          setValue((prev) => {
            const trimmed = prev.trim();
            const separator = trimmed ? ' ' : '';
            const nextValue = `${trimmed}${separator}${text}`;
            valueRef.current = nextValue;
            inputValueRef.current = nextValue;
            return nextValue;
          });
        },
      }),
      [sessionId, deleteDraft, disabled, inputValueRef, mutationLockedRef]
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
          if (valueRef.current.trim() || hasExternalInput) {
            onSubmit();
          }
        }
      },
      [hasExternalInput, onSubmit]
    );

    return (
      <AutocompleteTextarea
        ref={textareaElementRef}
        value={value}
        disabled={disabled}
        onChange={handlePromptChange}
        placeholder={placeholder}
        autoSize={autoSize}
        onKeyPress={handleKeyPress}
        client={client}
        sessionId={sessionId}
        userById={userById}
        onFilesDrop={onFilesDrop}
        filesDropDisabled={filesDropDisabled}
        showFilesDropOverlay={showFilesDropOverlay}
        suppressEmptyHighlight={suppressEmptyHighlight}
        slashCommands={slashCommands}
        skills={skills}
        enableKnowledgeMentions
        kbLinkTarget="absolute-route"
        highlightWhenEmpty
      />
    );
  }
);

PromptInput.displayName = 'PromptInput';

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

// Stable fallback so renders before the reactive session hydrates don't mint
// a fresh array — the memos deriving footer props from `tasks` (and through
// them the memoized SessionFooter) key on its identity.
const EMPTY_TASKS: Task[] = [];

export interface SessionPanelProps {
  client: AgorClient | null;
  session: Session | null;
  branch?: Branch | null;
  currentUserId?: string;
  sessionMcpServerIds?: string[];
  open: boolean;
  onClose: () => void;
}

const SessionPanel: React.FC<SessionPanelProps> = ({
  client,
  session,
  branch = null,
  currentUserId,
  sessionMcpServerIds = [],
  open,
  onClose,
}) => {
  const { token } = theme.useToken();
  const { modal } = App.useApp();
  const { showSuccess, showInfo, showError } = useThemedMessage();
  const connectionDisabled = useConnectionDisabled();
  const recenterMap = useRecenterMap();

  // Subscribe only to the entity families this panel needs via narrow store
  // selectors. SessionPanel intentionally does NOT subscribe to live (sessions
  // / branches / boards) slices here, so streaming session patches don't
  // re-render it; each whole-map selector is a stable module-level reference, so
  // user and MCP updates are isolated from each other and from repo edits.
  const userById = useAgorStore(selectUserById);
  const mcpServerById = useAgorStore(selectMcpServerById);
  const userAuthenticatedMcpServerIds = useAgorStore(selectUserAuthenticatedMcpServerIds);
  const sessionLinksSelector = React.useMemo(
    () => makeLinksForSessionSelector(session?.session_id ?? ''),
    [session?.session_id]
  );
  const sessionLinks = useAgorStore(sessionLinksSelector) ?? [];
  const currentBranchLinksSelector = React.useMemo(
    () => makeLinksForBranchSelector(branch?.branch_id ?? ''),
    [branch?.branch_id]
  );
  const currentBranchLinks = useAgorStore(currentBranchLinksSelector) ?? [];
  const boardById = useAgorStore(selectBoardById);
  const teammateBranchId = branch?.board_id
    ? (boardById.get(branch.board_id)?.primary_teammate_id ?? null)
    : null;
  const teammateLinksSelector = React.useMemo(
    () => makeLinksForBranchSelector(teammateBranchId ?? ''),
    [teammateBranchId]
  );
  const teammateLinks = useAgorStore(teammateLinksSelector) ?? [];
  const fetchAndReplaceFullSessionLinks = useAgorStore(selectFetchAndReplaceFullSessionLinks);
  const fetchAndReplaceFullBranchLinks = useAgorStore(selectFetchAndReplaceFullBranchLinks);
  // The ref blocks same-tick re-entry; reactive state locks composer mutations
  // for the full lifetime of every prompt, fork, BTW, or spawn action.
  const composerActionInFlightRef = React.useRef(false);
  const [composerBusy, setComposerBusy] = React.useState(false);
  const {
    pinningKeys,
    teammateBusyKeys,
    togglePinned: handleToggleSessionLinkPinned,
    promoteToTeammate: handlePromoteSessionLinkToTeammate,
    removeFromTeammate: handleRemoveSessionLinkFromTeammate,
  } = useLinkMutations({
    client,
    branchId: branch?.branch_id,
    sessionId: session?.session_id,
    teammateBranchId,
  });
  const [sessionLinksLoading, setSessionLinksLoading] = React.useState(false);
  const [sessionLinksError, setSessionLinksError] = React.useState<string | null>(null);
  const linksLoadRequestRef = React.useRef(0);

  // Get actions from context
  const { onSendPrompt, onFork, onBtwFork, onOpenSettings, onUpdateSession, onOpenTerminal } =
    useAppActions();

  const { archiveSession } = useSessionActions(client);

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

  // getDefaultPermissionMode imported from @agor-live/client — canonical
  // per-tool defaults live in core's `getDefaultPermissionMode`. The local
  // shadow that used to live here was stale (missing gemini/opencode/copilot)
  // and silently drifted from the core definition.

  const initialPermissionMode: PermissionMode =
    session?.permission_config?.mode ??
    (session?.agentic_tool
      ? getDefaultPermissionMode(session.agentic_tool)
      : getDefaultPermissionMode('claude-code'));
  const initialCodexDefaults = mapToCodexPermissionConfig(initialPermissionMode);
  const [permissionMode, setPermissionMode] = React.useState<PermissionMode>(initialPermissionMode);
  const [codexSandboxMode, setCodexSandboxMode] = React.useState<CodexSandboxMode>(
    session?.permission_config?.codex?.sandboxMode ?? initialCodexDefaults.sandboxMode
  );
  const [codexApprovalPolicy, setCodexApprovalPolicy] = React.useState<CodexApprovalPolicy>(
    session?.permission_config?.codex?.approvalPolicy ?? initialCodexDefaults.approvalPolicy
  );
  const [effortLevel, setEffortLevel] = React.useState<EffortLevel>(
    session?.model_config?.effort || 'high'
  );
  /**
   * Claude Code CLI view toggle: 'terminal' shows the embedded `claude`
   * REPL full-height (with the Agor textarea hidden, since `claude` has
   * its own input prompt); 'conversation' shows Agor's standard message
   * feed rebuilt from the JSONL by the daemon watcher.
   *
   * Only meaningful when `session.agentic_tool === 'claude-code-cli'`.
   * Defaults to 'terminal' so users see the live REPL on first open.
   * Persisting this per-session as a UI preference is a v1.5 follow-up.
   */
  const [cliViewMode, setCliViewMode] = React.useState<'terminal' | 'conversation'>('terminal');
  const [scrollToBottom, setScrollToBottom] = React.useState<(() => void) | null>(null);
  const [scrollToTop, setScrollToTop] = React.useState<(() => void) | null>(null);
  const [queuedTasks, setQueuedTasks] = React.useState<Task[]>([]);
  const [forkModalOpen, setForkModalOpen] = React.useState(false);
  const [spawnModalOpen, setSpawnModalOpen] = React.useState(false);
  const forkModalGenerationRef = React.useRef(0);
  const spawnModalGenerationRef = React.useRef(0);
  const [uploadModalOpen, setUploadModalOpen] = React.useState(false);
  const [advancedUploadInitialFiles, setAdvancedUploadInitialFiles] = React.useState<File[]>([]);
  const [composerDropActive, setComposerDropActive] = React.useState(false);
  const [stopRequestInFlight, setStopRequestInFlight] = React.useState(false);
  const openPinnedLinksManagerRef = React.useRef<(() => void) | null>(null);
  const reactiveSessionId = session?.session_id ?? null;
  const { state: reactiveSessionState } = useSharedReactiveSession(client, reactiveSessionId, {
    enabled: open,
    reactiveOptions: { taskHydration: 'none' },
  });

  const tasks = reactiveSessionState?.tasks || EMPTY_TASKS;
  const attachmentInputRef = React.useRef<HTMLInputElement>(null);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  // Search observes only the conversation region, not the whole body: the
  // no-results overlay, footer, and modals are `bodyRef` children, so observing
  // `bodyRef` would let the overlay's own mount/unmount retrigger the scan.
  const conversationRef = React.useRef<HTMLDivElement | null>(null);
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);
  const {
    searchOpen,
    query,
    setQuery,
    totalMatches,
    currentMatch,
    searchPending,
    openSearch,
    closeSearch,
    goNext,
    goPrev,
  } = useSessionSearch(conversationRef);
  const composerSessionIdentityRef = React.useRef<{
    sessionId: SessionID | null;
    generation: number;
  }>({
    sessionId: session?.session_id ?? null,
    generation: 0,
  });
  const currentComposerSessionId = session?.session_id ?? null;
  if (composerSessionIdentityRef.current.sessionId !== currentComposerSessionId) {
    composerSessionIdentityRef.current = {
      sessionId: currentComposerSessionId,
      generation: composerSessionIdentityRef.current.generation + 1,
    };
  }
  const {
    attachments: composerAttachments,
    attachmentsRef: composerAttachmentsRef,
    clearAttachments: clearComposerAttachments,
    hasAttachments: hasComposerAttachments,
    addAttachments: addComposerAttachments,
    removeAttachment: removeComposerAttachment,
    uploadAttachments: uploadComposerAttachments,
    uploadingRef: composerAttachmentUploadingRef,
    validationError: composerAttachmentValidationError,
    setValidationError: setComposerAttachmentValidationError,
  } = useComposerAttachments({
    sessionId: session?.session_id ?? null,
    showError,
    mutationLockedRef: composerActionInFlightRef,
  });

  const beginComposerAction = () => {
    if (composerActionInFlightRef.current) return false;
    composerActionInFlightRef.current = true;
    setComposerBusy(true);
    return true;
  };
  const finishComposerAction = () => {
    composerActionInFlightRef.current = false;
    setComposerBusy(false);
  };
  const composerStillOwnsAction = (
    actionSessionId: SessionID,
    actionIdentity: { sessionId: SessionID | null; generation: number }
  ) =>
    composerSessionIdentityRef.current.sessionId === actionSessionId &&
    composerSessionIdentityRef.current.generation === actionIdentity.generation;

  const loadSessionLinks = React.useCallback(async () => {
    if (!open || !client || !session?.session_id) return;
    const requestId = ++linksLoadRequestRef.current;
    setSessionLinksLoading(true);
    setSessionLinksError(null);
    const requests = [fetchAndReplaceFullSessionLinks(client, session.session_id)];
    if (branch?.branch_id) {
      requests.push(fetchAndReplaceFullBranchLinks(client, branch.branch_id));
    }
    if (teammateBranchId && teammateBranchId !== branch?.branch_id) {
      requests.push(fetchAndReplaceFullBranchLinks(client, teammateBranchId));
    }
    const results = await Promise.allSettled(requests);
    if (requestId !== linksLoadRequestRef.current) return;
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failure) {
      const detail =
        failure.reason instanceof Error ? failure.reason.message : String(failure.reason);
      setSessionLinksError(`Failed to load links: ${detail}`);
    }
    setSessionLinksLoading(false);
  }, [
    teammateBranchId,
    branch?.branch_id,
    client,
    fetchAndReplaceFullBranchLinks,
    fetchAndReplaceFullSessionLinks,
    open,
    session?.session_id,
  ]);

  React.useEffect(() => {
    void loadSessionLinks();
    return () => {
      linksLoadRequestRef.current += 1;
    };
  }, [loadSessionLinks]);

  // Fetch queued tasks (post never-lose-prompt: queueing lives on tasks, not messages).
  React.useEffect(() => {
    if (!client || !session) return;

    const fetchQueue = async () => {
      try {
        const response = await client.service(`/sessions/${session.session_id}/tasks/queue`).find();
        const data = (response as { data: Task[] }).data || [];
        setQueuedTasks(data);
      } catch (error) {
        console.error('[SessionPanel] Failed to fetch queue:', error);
      }
    };

    fetchQueue();

    const tasksService = client.service('tasks');

    const handleQueued = (task: Task) => {
      if (task.session_id === session.session_id) {
        setQueuedTasks((prev) => {
          // Deduplicate: optimistic update from enqueue may have already added this task
          if (prev.some((t) => t.task_id === task.task_id)) return prev;
          return [...prev, task].sort((a, b) => (a.queue_position ?? 0) - (b.queue_position ?? 0));
        });
      }
    };

    // A queued task drops out of the drawer when its status flips off 'queued'
    // (drained by spawnTaskExecutor → RUNNING, or admin-cancelled to STOPPED).
    const handleTaskPatched = (task: Task) => {
      if (task.session_id !== session.session_id) return;
      if (task.status !== TaskStatus.QUEUED) {
        setQueuedTasks((prev) => prev.filter((t) => t.task_id !== task.task_id));
      }
    };

    const handleTaskRemoved = (task: Task) => {
      if (task.session_id === session.session_id) {
        setQueuedTasks((prev) => prev.filter((t) => t.task_id !== task.task_id));
      }
    };

    tasksService.on('queued', handleQueued);
    tasksService.on('patched', handleTaskPatched);
    tasksService.on('updated', handleTaskPatched);
    tasksService.on('removed', handleTaskRemoved);

    return () => {
      tasksService.off('queued', handleQueued);
      tasksService.off('patched', handleTaskPatched);
      tasksService.off('updated', handleTaskPatched);
      tasksService.off('removed', handleTaskRemoved);
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
            // Forward the full normalized response so ContextWindowPill can
            // honor `contextUsageSnapshot.percentage` instead of recomputing
            // from raw used/limit (which is wrong for Codex's baseline-adjusted
            // display).
            taskMetadata: {
              model: task.model,
              duration_ms: task.duration_ms,
              agentic_tool: session.agentic_tool,
              raw_sdk_response: task.raw_sdk_response,
              normalized_sdk_response: task.normalized_sdk_response,
            },
          };
        }
      }
    }
    return null;
  }, [tasks, session?.agentic_tool]);

  const linkDisplayItems = React.useMemo(
    () => buildLinkDisplayItems({ branch, links: [...sessionLinks, ...currentBranchLinks] }),
    [branch, currentBranchLinks, sessionLinks]
  );
  const attachmentItems = linkDisplayItems;

  const pinnedContextLinkItems = React.useMemo(
    () => selectPinnedLinkDisplayItems(linkDisplayItems),
    [linkDisplayItems]
  );
  const attachmentLinksByMessageId = React.useMemo(() => {
    return groupRenderableLinksByMessageId(sessionLinks);
  }, [sessionLinks]);

  const handleRegisterOpenPinnedManager = React.useCallback(
    (openPinnedManager: (() => void) | null) => {
      openPinnedLinksManagerRef.current = openPinnedManager;
    },
    []
  );

  const handleOpenPinnedManager = React.useCallback(() => {
    openPinnedLinksManagerRef.current?.();
  }, []);

  const footerGradient = React.useMemo(() => {
    if (!latestContextWindow) return undefined;
    return getContextWindowGradient(
      latestContextWindow.used,
      latestContextWindow.limit,
      latestContextWindow.taskMetadata.normalized_sdk_response?.contextUsageSnapshot,
      {
        normal: token.colorSuccessBg,
        warning: token.colorWarningBg,
        critical: token.colorErrorBg,
      }
    );
  }, [latestContextWindow, token.colorSuccessBg, token.colorWarningBg, token.colorErrorBg]);

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
  }, [session?.permission_config?.mode, session?.permission_config?.codex, session?.agentic_tool]);

  // Update effort level when session changes (default to 'high' for sessions without effort config)
  React.useEffect(() => {
    setEffortLevel(session?.model_config?.effort || 'high');
  }, [session?.model_config?.effort]);

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f' && open) {
        e.preventDefault();
        if (!searchOpen) openSearch();
        else searchInputRef.current?.focus();
      }
      if (e.key === 'Escape' && searchOpen) closeSearch();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [searchOpen, open, openSearch, closeSearch]);

  // Reset search when switching sessions — stale ranges/counts belong to the
  // previous conversation's DOM.
  const prevSearchSessionIdRef = React.useRef(session?.session_id ?? null);
  React.useEffect(() => {
    const id = session?.session_id ?? null;
    if (prevSearchSessionIdRef.current !== id) {
      prevSearchSessionIdRef.current = id;
      closeSearch();
    }
  }, [session?.session_id, closeSearch]);

  React.useEffect(() => {
    if (searchOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 30);
    }
  }, [searchOpen]);

  const isRunning =
    session?.status === SessionStatus.RUNNING || session?.status === SessionStatus.STOPPING;
  const isStopping = session?.status === SessionStatus.STOPPING;

  // SessionFooter is memoized, but its handlers close over per-render state
  // and are defined below the null-session early return, so they can't be
  // useCallback'd directly. Freeze the identities the footer sees with
  // lifetime-stable wrappers that delegate to the latest implementations via
  // a ref (re-pointed each render, right where the impls are defined).
  const footerHandlersRef = React.useRef<{
    onModelConfigChange: (config: ModelConfig) => void;
    onSendPrompt: () => void;
    onStop: () => void;
    onFork: () => void;
    onBtwSend: () => void;
    onSpawnOpen: () => void;
    onAttachFiles: () => void;
    onUploadOpen: () => void;
    onEffortChange: (v: EffortLevel) => void;
    onPermissionModeChange: (v: PermissionMode) => void;
    onCodexPermissionChange: (sandbox: CodexSandboxMode, approval: CodexApprovalPolicy) => void;
  } | null>(null);
  const stableFooterHandlers = React.useMemo(
    () => ({
      onModelConfigChange: (config: ModelConfig) =>
        footerHandlersRef.current?.onModelConfigChange(config),
      onSendPrompt: () => footerHandlersRef.current?.onSendPrompt(),
      onStop: () => footerHandlersRef.current?.onStop(),
      onFork: () => footerHandlersRef.current?.onFork(),
      onBtwSend: () => footerHandlersRef.current?.onBtwSend(),
      onSpawnOpen: () => footerHandlersRef.current?.onSpawnOpen(),
      onAttachFiles: () => footerHandlersRef.current?.onAttachFiles(),
      onUploadOpen: () => footerHandlersRef.current?.onUploadOpen(),
      onEffortChange: (v: EffortLevel) => footerHandlersRef.current?.onEffortChange(v),
      onPermissionModeChange: (v: PermissionMode) =>
        footerHandlersRef.current?.onPermissionModeChange(v),
      onCodexPermissionChange: (sandbox: CodexSandboxMode, approval: CodexApprovalPolicy) =>
        footerHandlersRef.current?.onCodexPermissionChange(sandbox, approval),
    }),
    []
  );

  const modelLabel =
    session?.model_config?.model &&
    session.agentic_tool === 'opencode' &&
    session.model_config.provider
      ? `${session.model_config.provider}/${session.model_config.model}`
      : session?.model_config?.model;
  const modelConfig: ModelConfig | undefined = React.useMemo(
    () =>
      session?.model_config?.model
        ? {
            mode: session.model_config.mode || 'alias',
            model: session.model_config.model,
            provider: session.model_config.provider,
            advisorModel: session.model_config.advisorModel,
          }
        : undefined,
    [
      session?.model_config?.mode,
      session?.model_config?.model,
      session?.model_config?.provider,
      session?.model_config?.advisorModel,
    ]
  );

  // The composer subtree only depends on composer/draft state — memoize it so
  // ordinary SessionPanel re-renders (reactive-session notifies, store
  // patches) hand the memoized SessionFooter a reference-stable slot.
  const sessionCustomContext = session?.custom_context as Record<string, unknown> | undefined;
  const promptInputSlot = React.useMemo(() => {
    if (!session) return null;
    return (
      <SessionComposerDropZone
        disabled={composerBusy}
        onDragActiveChange={setComposerDropActive}
        onFilesDrop={addComposerAttachments}
      >
        {composerAttachmentValidationError && (
          <Alert
            type="error"
            showIcon
            message={composerAttachmentValidationError}
            style={{ marginBottom: 0, borderRadius: token.borderRadius }}
          />
        )}
        <SessionAttachmentTray
          attachments={composerAttachments}
          disabled={composerBusy}
          onRemove={removeComposerAttachment}
        />
        <PromptInput
          ref={promptRef}
          sessionId={session.session_id}
          getDraft={getDraft}
          saveDraft={saveDraft}
          deleteDraft={deleteDraft}
          onHasInputChange={handleHasInputChange}
          inputValueRef={inputValueRef}
          onSubmit={stableFooterHandlers.onSendPrompt}
          hasExternalInput={hasComposerAttachments}
          disabled={composerBusy}
          mutationLockedRef={composerActionInFlightRef}
          placeholder={
            isRunning
              ? 'Queue here… @ for mentions, : for emoji'
              : 'Prompt here… @ for mentions, : for emoji'
          }
          autoSize={{ minRows: 1, maxRows: 10 }}
          client={client}
          userById={userById}
          onFilesDrop={addComposerAttachments}
          filesDropDisabled={composerBusy}
          showFilesDropOverlay={false}
          suppressEmptyHighlight={composerDropActive}
          slashCommands={
            Array.isArray(sessionCustomContext?.slash_commands)
              ? sessionCustomContext.slash_commands
              : undefined
          }
          skills={
            Array.isArray(sessionCustomContext?.skills) ? sessionCustomContext.skills : undefined
          }
        />
        <input
          ref={attachmentInputRef}
          type="file"
          accept={getComposerUploadAccept()}
          multiple
          disabled={composerBusy}
          style={{ display: 'none' }}
          onChange={(event) => {
            addComposerAttachments(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
      </SessionComposerDropZone>
    );
  }, [
    session,
    sessionCustomContext,
    composerBusy,
    composerAttachmentValidationError,
    composerAttachments,
    composerDropActive,
    hasComposerAttachments,
    isRunning,
    client,
    userById,
    addComposerAttachments,
    removeComposerAttachment,
    getDraft,
    saveDraft,
    deleteDraft,
    handleHasInputChange,
    stableFooterHandlers,
    token.borderRadius,
  ]);

  // When there's no session, render nothing (panel is collapsed to zero).
  // When open=false, we still render the component tree (hidden) so that
  // antd's CSS-in-JS doesn't garbage-collect component styles.
  if (!session) {
    return null;
  }

  const handleArchive = () => {
    if (!client || connectionDisabled) {
      showError('Cannot archive while disconnected from the daemon.');
      return;
    }

    modal.confirm({
      title: 'Archive session and child sessions?',
      content: 'Are you sure you want to archive this session and its child sessions?',
      okText: 'Archive',
      cancelText: 'Cancel',
      onOk: async () => {
        const archived = await archiveSession(session.session_id);
        if (archived) {
          showSuccess('Session and child sessions archived');
          onClose();
        } else {
          showError('Failed to archive session');
        }
      },
    });
  };

  const hasBranchActions = !!branch;
  const moreMenuItems: MenuProps['items'] = [
    ...(branch
      ? [
          {
            key: 'center-map',
            icon: <AimOutlined />,
            label: 'Center map on branch',
            onClick: () => recenterMap(branch.branch_id, { boardId: branch.board_id ?? undefined }),
          },
        ]
      : []),
    ...(onOpenTerminal && branch
      ? [
          {
            key: 'terminal',
            icon: <CodeOutlined />,
            label: 'Open terminal',
            onClick: () => onOpenTerminal([], branch.branch_id),
          },
        ]
      : []),
    ...(hasBranchActions ? [{ type: 'divider' as const }] : []),
    ...(onOpenSettings
      ? [
          {
            key: 'settings',
            icon: <SettingOutlined />,
            label: 'Session Settings',
            onClick: () => onOpenSettings(session.session_id),
          },
        ]
      : []),
    {
      key: 'archive',
      icon: <InboxOutlined />,
      label: connectionDisabled ? 'Archive (disconnected)' : 'Archive session',
      disabled: connectionDisabled || !client,
      onClick: handleArchive,
    },
  ];

  const openAdvancedUpload = (initialFiles: File[] = []) => {
    if (composerActionInFlightRef.current || composerAttachmentUploadingRef.current) return;
    setAdvancedUploadInitialFiles(initialFiles);
    setUploadModalOpen(true);
  };

  const handleSendPrompt = async () => {
    if (
      composerActionInFlightRef.current ||
      composerAttachmentUploadingRef.current ||
      connectionDisabled
    ) {
      return;
    }

    if (!beginComposerAction()) return;
    try {
      const sendStartSessionId = session.session_id;
      const sendStartComposerIdentity = composerSessionIdentityRef.current;
      const value = promptRef.current?.getValue() ?? '';
      const attachmentsAtSendStart = composerAttachmentsRef.current;
      const hasAttachments = attachmentsAtSendStart.length > 0;
      if (!value.trim() && !hasAttachments) return;

      const blockingAttachment = attachmentsAtSendStart.find(isBlockingComposerAttachment);
      if (blockingAttachment) {
        showError(
          `${blockingAttachment.file.name} failed or cannot be uploaded. Remove failed files before sending.`
        );
        return;
      }

      if (!onSendPrompt) {
        showError('Cannot send prompt from this view.');
        return;
      }

      const uploadedFiles = await uploadComposerAttachments(
        attachmentsAtSendStart,
        sendStartSessionId
      );
      const attachmentPaths = uploadedFiles.map((file) => file.path);
      const promptToSend = buildPromptWithAttachments(value, attachmentPaths);
      if (!promptToSend.trim()) return;

      // Single entry point: /prompt. The daemon decides run-vs-queue based on
      // session state and reports it back via `task.status`. The 'queued'
      // WebSocket event populates the queue panel for queued prompts.
      const uploadLinkIds = uploadedFiles.flatMap((file) =>
        file.linkId ? [file.linkId as Link['link_id']] : []
      );
      const sendResult = uploadLinkIds.length
        ? await onSendPrompt?.(sendStartSessionId, promptToSend, permissionMode, uploadLinkIds)
        : await onSendPrompt?.(sendStartSessionId, promptToSend, permissionMode);
      if (sendResult === false) return;
      if (
        uploadLinkIds.length > 0 &&
        composerStillOwnsAction(sendStartSessionId, sendStartComposerIdentity)
      ) {
        // The daemon attributes upload links to the newly persisted user
        // message during prompt creation. Refetch here instead of relying on a
        // pair of rapid created/patched socket events arriving in order.
        await loadSessionLinks();
      }

      if (composerStillOwnsAction(sendStartSessionId, sendStartComposerIdentity)) {
        promptRef.current?.clear();
        clearComposerAttachments();
        setComposerAttachmentValidationError(null);
      } else {
        // The old composer is no longer live; clear only its saved draft so the
        // successfully sent snapshot does not reappear when the user returns.
        // Never call promptRef.current?.clear() here because it now belongs to
        // a different active session.
        deleteDraft(sendStartSessionId);
      }

      // Re-engage the bottom lock so a scrolled-up user follows their just-sent
      // message and the streaming reply (behavior 3). `scrollToBottom` is the
      // function ConversationView exposed via onScrollRef.
      if (composerStillOwnsAction(sendStartSessionId, sendStartComposerIdentity)) {
        scrollToBottom?.();
      }
    } catch (error) {
      console.error('Composer send failed — keeping prompt and files in composer:', error);
      showError(error instanceof Error ? error.message : 'Failed to send prompt');
    } finally {
      finishComposerAction();
    }
  };

  const handleStop = async () => {
    if (!session || !client || stopRequestInFlight) return;

    // Show feedback immediately if this is a retry
    if (isStopping) {
      showInfo('Retrying stop request...');
    }

    setStopRequestInFlight(true);
    try {
      await client.service(`sessions/${session.session_id}/stop`).create({});
    } catch (error) {
      console.error('Failed to stop execution:', error);
      showError('Failed to stop execution. You can try again.');
    } finally {
      setStopRequestInFlight(false);
    }
  };

  const teammateStateForSessionLink = (item: LinkDisplayItem) => {
    const state = getTeammatePromotionState({
      item,
      teammateBranchId,
      sourceBranchId: branch?.branch_id ?? null,
      teammateLinks,
    });
    const unavailableReason = getTeammatePromotionUnavailableReason(state);
    const actionKey = item.linkId ?? item.key;
    return {
      isPromoted: state.isPromoted,
      teammateLinkId: state.teammateLink?.link_id,
      disabled: !state.canPromote || !client || connectionDisabled,
      loading: teammateBusyKeys.has(actionKey),
      unavailableReason:
        unavailableReason ??
        (!client || connectionDisabled
          ? 'Teammate link actions unavailable while disconnected'
          : null),
    };
  };

  const handleFork = async () => {
    if (!session || composerActionInFlightRef.current) return;
    if (composerAttachmentsRef.current.length > 0) {
      showError(
        'Attachments are only supported for normal Send for now. Remove attachments to fork.'
      );
      return;
    }
    const value = promptRef.current?.getValue() ?? '';
    const promptToSend = value.trim();
    if (!promptToSend) {
      forkModalGenerationRef.current += 1;
      setForkModalOpen(true);
      return;
    }
    if (!beginComposerAction()) return;
    const actionSessionId = session.session_id;
    const actionIdentity = composerSessionIdentityRef.current;
    try {
      await onFork?.(actionSessionId, promptToSend);
      // Only clear the compose box + draft on success, so a failed fork
      // leaves the typed prompt intact for the user to retry.
      if (composerStillOwnsAction(actionSessionId, actionIdentity)) {
        promptRef.current?.clear();
      } else {
        deleteDraft(actionSessionId);
      }
    } catch (error) {
      console.error('Fork failed — keeping prompt in compose box:', error);
    } finally {
      finishComposerAction();
    }
  };

  const handleForkModalConfirm = async (config: string | Partial<SpawnConfig>) => {
    if (!session) return;
    const prompt = typeof config === 'string' ? config : (config.prompt ?? '');
    if (!prompt) return;
    if (!beginComposerAction()) throw new Error('Another composer action is already in progress.');
    const actionSessionId = session.session_id;
    const actionIdentity = composerSessionIdentityRef.current;
    const modalGeneration = forkModalGenerationRef.current;
    try {
      await onFork?.(actionSessionId, prompt);
      return (
        composerStillOwnsAction(actionSessionId, actionIdentity) &&
        forkModalGenerationRef.current === modalGeneration
      );
    } finally {
      finishComposerAction();
    }
  };

  const handleBtwSend = async () => {
    if (composerActionInFlightRef.current) return;
    if (composerAttachmentsRef.current.length > 0) {
      showError(
        'Attachments are only supported for normal Send for now. Remove attachments to send BTW.'
      );
      return;
    }
    const value = promptRef.current?.getValue() ?? '';
    if (!value.trim() || connectionDisabled) return;
    const promptToSend = value.trim();
    if (!beginComposerAction()) return;
    const actionSessionId = session.session_id;
    const actionIdentity = composerSessionIdentityRef.current;
    try {
      await onBtwFork?.(actionSessionId, promptToSend);
      if (composerStillOwnsAction(actionSessionId, actionIdentity)) {
        promptRef.current?.clear();
      } else {
        deleteDraft(actionSessionId);
      }
    } catch (error) {
      console.error('BTW fork failed — keeping prompt in compose box:', error);
    } finally {
      finishComposerAction();
    }
  };

  const handleSpawnOpen = () => {
    if (composerActionInFlightRef.current) return;
    if (composerAttachmentsRef.current.length > 0) {
      showError(
        'Attachments are only supported for normal Send for now. Remove attachments to spawn.'
      );
      return;
    }
    spawnModalGenerationRef.current += 1;
    setSpawnModalOpen(true);
  };

  const handleSpawnModalConfirm = async (config: string | Partial<SpawnConfig>) => {
    if (!session || !client) return;
    if (!beginComposerAction()) throw new Error('Another composer action is already in progress.');
    const actionSessionId = session.session_id;
    const actionIdentity = composerSessionIdentityRef.current;
    const modalGeneration = spawnModalGenerationRef.current;

    // Daemon owns the spawn-subsession meta-prompt template. The UI sends raw
    // `{userPrompt, config}` to /sessions/:id/spawn-prompt, which renders the
    // meta-prompt and forwards it to /sessions/:id/prompt in one round trip.
    //
    // `parentPermissionMode` is the *parent* session's permission mode for the
    // forwarding prompt; the spawn config's `permissionMode` is rendered into
    // the meta-prompt as the *child* session's intended mode. They're distinct
    // — don't reuse one for the other.
    const spawnConfig =
      typeof config === 'string'
        ? { userPrompt: config }
        : {
            userPrompt: config.prompt || '',
            agenticTool: config.agent,
            permissionMode: config.permissionMode,
            modelConfig: config.modelConfig,
            codexSandboxMode: config.codexSandboxMode,
            codexApprovalPolicy: config.codexApprovalPolicy,
            codexNetworkAccess: config.codexNetworkAccess,
            mcpServerIds: config.mcpServerIds,
            callbackConfig: {
              enableCallback: config.enableCallback,
              includeLastMessage: config.includeLastMessage,
              includeOriginalPrompt: config.includeOriginalPrompt,
            },
            extraInstructions: config.extraInstructions,
          };

    try {
      await client
        .service(`sessions/${actionSessionId}/spawn-prompt`)
        .create({ ...spawnConfig, parentPermissionMode: permissionMode });

      const composerStillOwnsSpawn = composerStillOwnsAction(actionSessionId, actionIdentity);
      const modalStillOwnsSpawn = spawnModalGenerationRef.current === modalGeneration;
      if (composerStillOwnsSpawn && modalStillOwnsSpawn) {
        promptRef.current?.clear();
        return true;
      }
      if (!composerStillOwnsSpawn) {
        deleteDraft(actionSessionId);
      }
      return false;
    } finally {
      finishComposerAction();
    }
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

  const handleModelConfigChange = (newConfig: ModelConfig) => {
    if (session && onUpdateSession) {
      const nextConfig: NonNullable<Session['model_config']> = {
        ...session.model_config,
        mode: newConfig.mode,
        model: newConfig.model,
        ...(newConfig.provider ? { provider: newConfig.provider } : {}),
        updated_at: new Date().toISOString(),
      };
      // Honor the advisor selector's clear action. `model_config` is
      // column-replaced on patch, so we must DELETE the key when the user clears
      // it (allowClear → undefined) — the spread above would otherwise silently
      // carry the previous value forward (root cause of "no way to turn it off").
      if (newConfig.advisorModel) {
        nextConfig.advisorModel = newConfig.advisorModel;
      } else {
        delete nextConfig.advisorModel;
      }
      onUpdateSession(session.session_id, { model_config: nextConfig });
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

  // Re-point the stable footer wrappers at this render's implementations.
  // Render-phase ref write (instead of the usual useLayoutEffect) because the
  // impls above only exist when `session` is non-null, past the early return.
  footerHandlersRef.current = {
    onModelConfigChange: handleModelConfigChange,
    onSendPrompt: handleSendPrompt,
    onStop: handleStop,
    onFork: handleFork,
    onBtwSend: handleBtwSend,
    onSpawnOpen: handleSpawnOpen,
    onAttachFiles: () => attachmentInputRef.current?.click(),
    onUploadOpen: () => openAdvancedUpload(),
    onEffortChange: handleEffortChange,
    onPermissionModeChange: handlePermissionModeChange,
    onCodexPermissionChange: handleCodexPermissionChange,
  };

  const sessionFooter = (
    <SessionFooter
      session={session}
      footerTimerTask={footerTimerTask}
      tokenBreakdown={tokenBreakdown}
      latestContextWindow={latestContextWindow}
      footerGradient={footerGradient}
      sessionMcpServerIds={sessionMcpServerIds}
      unauthedMcpServers={unauthedMcpServers}
      mcpServerById={mcpServerById}
      userAuthenticatedMcpServerIds={userAuthenticatedMcpServerIds}
      isRunning={isRunning}
      isStopping={isStopping}
      stopRequestInFlight={stopRequestInFlight}
      hasInput={hasInput || hasComposerAttachments}
      composerAttachmentsPresent={hasComposerAttachments}
      composerBusy={composerBusy}
      connectionDisabled={connectionDisabled}
      toolCaps={toolCaps}
      effortLevel={effortLevel}
      permissionMode={permissionMode}
      codexSandboxMode={codexSandboxMode}
      codexApprovalPolicy={codexApprovalPolicy}
      queuedTasks={queuedTasks}
      client={client}
      modelLabel={modelLabel}
      modelConfig={modelConfig}
      onModelConfigChange={stableFooterHandlers.onModelConfigChange}
      onOpenSessionSettings={onOpenSettings}
      onSendPrompt={stableFooterHandlers.onSendPrompt}
      onStop={stableFooterHandlers.onStop}
      onFork={stableFooterHandlers.onFork}
      onBtwSend={stableFooterHandlers.onBtwSend}
      onSpawnOpen={stableFooterHandlers.onSpawnOpen}
      onAttachFiles={stableFooterHandlers.onAttachFiles}
      onUploadOpen={stableFooterHandlers.onUploadOpen}
      onEffortChange={stableFooterHandlers.onEffortChange}
      onPermissionModeChange={stableFooterHandlers.onPermissionModeChange}
      onCodexPermissionChange={stableFooterHandlers.onCodexPermissionChange}
      promptInputSlot={promptInputSlot}
    />
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
        {/* Row 1: icon + title + badge + actions, center-aligned */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flex: 1, minWidth: 0 }}>
            <div style={{ flexShrink: 0 }}>
              <ToolIcon tool={session.agentic_tool} size={40} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Typography.Text strong style={{ fontSize: 18, ...getSessionTitleStyles(2) }}>
                {getSessionDisplayTitle(session, { includeAgentFallback: true })}
              </Typography.Text>
              <Badge status={getStatusColor()} text={session.status.toUpperCase()} />
              {session.created_by && (
                <div style={{ marginTop: token.sizeUnit }}>
                  <CreatedByTag
                    createdBy={session.created_by}
                    currentUserId={currentUserId}
                    userById={userById}
                    prefix="Created by"
                  />
                </div>
              )}
            </div>
          </div>
          <Space size={4}>
            <SessionAttachmentsDropdown
              items={attachmentItems}
              loading={sessionLinksLoading}
              error={sessionLinksError}
              onRetry={() => void loadSessionLinks()}
              pinningKeys={pinningKeys}
              onTogglePinned={handleToggleSessionLinkPinned}
              onRegisterOpenPinnedManager={handleRegisterOpenPinnedManager}
              getTeammateActionState={teammateStateForSessionLink}
              onPromoteToTeammate={handlePromoteSessionLinkToTeammate}
              onRemoveFromTeammate={handleRemoveSessionLinkFromTeammate}
              teammatePromotionBusyKeys={teammateBusyKeys}
            />
            <Dropdown menu={{ items: moreMenuItems }} trigger={['click']} placement="bottomRight">
              <Tooltip title="More actions">
                <Button type="text" icon={<EllipsisOutlined />} />
              </Tooltip>
            </Dropdown>
            <Tooltip title={`Search session (${FIND_SHORTCUT_LABEL})`}>
              <Button type="text" icon={<SearchOutlined />} onClick={openSearch} />
            </Tooltip>
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
        {/* Row 2: search bar — always in DOM, animates in/out */}
        <div
          style={{
            overflow: 'hidden',
            maxHeight: searchOpen ? '36px' : '0px',
            opacity: searchOpen ? 1 : 0,
            marginTop: searchOpen ? '4px' : '0px',
            transition: 'max-height 0.15s ease, opacity 0.12s ease, margin-top 0.15s ease',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <SearchOutlined style={{ color: token.colorPrimary, fontSize: 14, flexShrink: 0 }} />
            <Input
              ref={(el) => {
                searchInputRef.current = el?.input ?? null;
              }}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.shiftKey ? goPrev() : goNext();
                if (e.key === 'Escape') closeSearch();
              }}
              placeholder="Search session..."
              variant="borderless"
              style={{ flex: 1, padding: 0 }}
              size="small"
            />
            {query && (
              <Typography.Text
                type="secondary"
                style={{
                  fontSize: 12,
                  whiteSpace: 'nowrap',
                  minWidth: 44,
                  textAlign: 'right',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {totalMatches > 0 ? `${currentMatch + 1} / ${totalMatches}` : ''}
              </Typography.Text>
            )}
            {!query && (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                Esc to close
              </Typography.Text>
            )}
            {totalMatches > 1 && (
              <Space size={2}>
                <Tooltip title="Previous (Shift+Enter)">
                  <Button type="text" size="small" icon={<UpOutlined />} onClick={goPrev} />
                </Tooltip>
                <Tooltip title="Next (Enter)">
                  <Button type="text" size="small" icon={<DownOutlined />} onClick={goNext} />
                </Tooltip>
              </Space>
            )}
            <Tooltip title="Close search (Esc)">
              <Button type="text" size="small" icon={<CloseOutlined />} onClick={closeSearch} />
            </Tooltip>
          </div>
        </div>
      </div>

      {/* Body - Scrollable content */}
      <div
        ref={bodyRef}
        style={{
          flex: 1,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          padding: `${token.sizeUnit * 3}px ${token.sizeUnit * 6}px 0`,
          position: 'relative',
        }}
      >
        {searchOpen && query.trim() && totalMatches === 0 && !searchPending && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 10,
              pointerEvents: 'none',
              background: `${token.colorBgContainer}cc`,
            }}
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                padding: '28px 16px',
                gap: 6,
              }}
            >
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  background: token.colorFillTertiary,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: 2,
                }}
              >
                <SearchOutlined style={{ fontSize: 16, color: token.colorTextTertiary }} />
              </div>
              <Typography.Text strong style={{ fontSize: 13 }}>
                No results
              </Typography.Text>
              <Typography.Text
                type="secondary"
                style={{ fontSize: 12, textAlign: 'center', lineHeight: 1.5, maxWidth: 200 }}
              >
                Nothing matched <Typography.Text code>{query}</Typography.Text>
              </Typography.Text>
            </div>
          </div>
        )}
        <div
          ref={conversationRef}
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <SessionPanelContent
            client={client}
            session={session}
            branch={branch}
            currentUserId={currentUserId}
            sessionMcpServerIds={sessionMcpServerIds}
            scrollToBottom={scrollToBottom}
            scrollToTop={scrollToTop}
            setScrollToBottom={setScrollToBottom}
            setScrollToTop={setScrollToTop}
            queuedTasks={queuedTasks}
            setQueuedTasks={setQueuedTasks}
            spawnModalOpen={spawnModalOpen}
            setSpawnModalOpen={(nextOpen) => {
              spawnModalGenerationRef.current += 1;
              setSpawnModalOpen(nextOpen);
            }}
            onSpawnModalConfirm={handleSpawnModalConfirm}
            inputValueRef={inputValueRef}
            isOpen={open}
            cliViewMode={cliViewMode}
            setCliViewMode={setCliViewMode}
            attachmentLinksByMessageId={attachmentLinksByMessageId}
            pinnedContextLinks={pinnedContextLinkItems}
            onPinnedOverflow={handleOpenPinnedManager}
            forceExpandAll={searchOpen && query.trim().length > 0}
          />
        </div>

        {/* Footer — rendered outside SessionPanelContent so that
            keystroke-driven re-renders don't propagate to ConversationView.
            Hidden for CLI sessions in 'terminal' view because the embedded
            `claude` REPL has its own input prompt; the Agor textarea is
            redundant (and would inject via PTY anyway, racy with whatever
            the user is typing into the REPL directly). */}
        {!(session.agentic_tool === 'claude-code-cli' && cliViewMode === 'terminal') &&
          sessionFooter}

        {/* Advanced upload modal preserves the existing file upload flow for
            non-image files and notify-agent options. */}
        <FileUpload
          sessionId={session.session_id}
          daemonUrl={getDaemonUrl()}
          open={uploadModalOpen}
          onClose={() => {
            setUploadModalOpen(false);
            setAdvancedUploadInitialFiles([]);
          }}
          initialFiles={advancedUploadInitialFiles}
          onUploadComplete={(files) => {
            showSuccess(`Uploaded ${files.length} file(s)`);
          }}
          onInsertMention={(filepath) => {
            promptRef.current?.insertText(`@${filepath}`);
          }}
        />

        {/* Fork modal — opened when Fork button is clicked with an empty textarea */}
        <ForkSpawnModal
          open={forkModalOpen}
          action="fork"
          session={session}
          currentUser={currentUserId ? (userById.get(currentUserId) ?? null) : null}
          onConfirm={handleForkModalConfirm}
          onCancel={() => {
            forkModalGenerationRef.current += 1;
            setForkModalOpen(false);
          }}
          client={client}
          userById={userById}
        />
      </div>
    </div>
  );
};

// SessionPanel reads only entity-context data (users, MCP servers) and receives
// session/branch as props. Wrapping with React.memo (default shallow compare)
// lets it bail out of re-renders triggered by App's live-context updates as
// long as its props are referentially stable. Callers MUST pass stable
// `onClose` and `sessionMcpServerIds` (use EMPTY_STRING_ARRAY for empty).
export default React.memo(SessionPanel);
