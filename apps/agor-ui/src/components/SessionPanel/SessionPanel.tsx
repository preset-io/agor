import { AGENTIC_TOOL_CAPABILITIES } from '@agor/agentic-tools';
import type {
  AgenticToolName,
  AgorClient,
  Branch,
  CodexApprovalPolicy,
  CodexSandboxMode,
  EffortLevel,
  PermissionMode,
  Session,
  SessionID,
  SessionStopResult,
  SpawnConfig,
  Task,
  User,
} from '@agor-live/client';
import {
  getDefaultPermissionMode,
  isAgenticToolName,
  mapToCodexPermissionConfig,
  SessionStatus,
  TaskStatus,
} from '@agor-live/client';
import {
  AimOutlined,
  CloseOutlined,
  CodeOutlined,
  DownOutlined,
  EditOutlined,
  EllipsisOutlined,
  InboxOutlined,
  RobotOutlined,
  SearchOutlined,
  SettingOutlined,
  UpOutlined,
} from '@ant-design/icons';
import type { InputRef, MenuProps } from 'antd';
import {
  Alert,
  App,
  Badge,
  Button,
  Dropdown,
  Input,
  Modal,
  Space,
  Spin,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import React from 'react';
import { getDaemonUrl } from '../../config/daemon';
import { useAppActions } from '../../contexts/AppActionsContext';
import { useRecenterMap } from '../../contexts/CanvasNavigationContext';
import { useConnectionDisabled, useConnectionState } from '../../contexts/ConnectionContext';
import { useAuthorityOperationGuard } from '../../hooks/useAuthorityOperationGuard';
import { useSessionActions } from '../../hooks/useSessionActions';
import { useSessionSearch } from '../../hooks/useSessionSearch';
import { useSharedReactiveSession } from '../../hooks/useSharedReactiveSession';
import { useAgorStore } from '../../store/agorStore';
import {
  selectMcpServerById,
  selectUserAuthenticatedMcpServerIds,
  selectUserById,
} from '../../store/selectors';
import { getContextWindowGradient } from '../../utils/contextWindow';
import {
  claimMarketplaceOAuthPrompt,
  consumeMarketplacePromptSuggestionState,
  discardMarketplaceOAuthAuthorityState,
  discardMarketplacePromptSuggestion,
  getMarketplacePromptStateRevision,
  isMarketplacePromptSuggestionCurrent,
  type MarketplacePromptSuggestionState,
  subscribeMarketplacePromptState,
} from '../../utils/marketplaceOAuthPrompt';
import { mcpServerNeedsAuth } from '../../utils/mcpAuth';
import { useThemedMessage } from '../../utils/message';
import { deletePromptDraft, getPromptDraft, savePromptDraft } from '../../utils/promptDrafts';
import { getSessionDisplayTitle, getSessionTitleStyles } from '../../utils/sessionTitle';
import { AgentSelectionGrid } from '../AgentSelectionGrid/AgentSelectionGrid';
import { AutocompleteTextarea } from '../AutocompleteTextarea';
import { FileUpload } from '../FileUpload';
import { ForkSpawnModal } from '../ForkSpawnModal/ForkSpawnModal';
import type { ModelConfig } from '../ModelSelector';
import { CreatedByTag } from '../metadata';
import { getUrlDisplayLabel } from '../Pill/url-helpers';
import { ToolIcon } from '../ToolIcon';
import {
  buildPromptWithAttachments,
  getComposerUploadAccept,
  getLatestComposerPromptText,
  isBlockingComposerAttachment,
} from './composerAttachments';
import { appendComposerText } from './composerText';
import { MarketplacePromptSuggestion } from './MarketplacePromptSuggestion';
import type { SessionAttachmentItem } from './SessionAttachmentsDropdown';
import { SessionAttachmentsDropdown } from './SessionAttachmentsDropdown';
import { SessionAttachmentTray } from './SessionAttachmentTray';
import { SessionComposerDropZone } from './SessionComposerDropZone';
import { SessionFooter } from './SessionFooter';
import { SessionPanelContent } from './SessionPanelContent';
import {
  isStopTransportAmbiguous,
  reconcileStopTransportFailure,
  requestSessionStop,
} from './stopReconciliation';
import { useComposerAttachments } from './useComposerAttachments';

// Re-export PermissionMode from SDK for convenience
export type { PermissionMode };

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
  deleteDraft: (id: string, expectedText?: string) => void;
  /** Fires only on empty↔non-empty transitions, not every keystroke */
  onHasInputChange: (hasInput: boolean) => void;
  /** Kept in sync so memoized children can read the latest value */
  inputValueRef: React.MutableRefObject<string>;
  /** Called on Enter (without Shift) when there is sendable composer content */
  onSubmit: () => void;
  hasExternalInput?: boolean;
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
        valueRef.current = nextValue;
        inputValueRef.current = nextValue;
        setValue(nextValue);
      },
      [inputValueRef]
    );

    // Track empty↔non-empty transitions → notify parent (minimal re-renders)
    const prevHasInput = React.useRef<boolean | null>(null);
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
          setValue((prev) => {
            const nextValue = appendComposerText(prev, text);
            valueRef.current = nextValue;
            inputValueRef.current = nextValue;
            return nextValue;
          });
        },
      }),
      [sessionId, deleteDraft, inputValueRef]
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
  uploadPolicy?: import('@agor/core/types').UploadIngressPolicy;
}

const SessionPanel: React.FC<SessionPanelProps> = ({
  client,
  session,
  branch = null,
  currentUserId,
  sessionMcpServerIds = [],
  open,
  onClose,
  uploadPolicy,
}) => {
  const { token } = theme.useToken();
  const { modal } = App.useApp();
  const { showSuccess, showInfo, showError } = useThemedMessage();
  const connectionDisabled = useConnectionDisabled();
  const { connected, connecting, authGeneration } = useConnectionState();
  const recenterMap = useRecenterMap();

  // Subscribe only to the entity families this panel needs via narrow store
  // selectors. SessionPanel intentionally does NOT subscribe to live (sessions
  // / branches / boards) slices here, so streaming session patches don't
  // re-render it; each whole-map selector is a stable module-level reference, so
  // user and MCP updates are isolated from each other and from repo edits.
  const userById = useAgorStore(selectUserById);
  const mcpServerById = useAgorStore(selectMcpServerById);
  const userAuthenticatedMcpServerIds = useAgorStore(selectUserAuthenticatedMcpServerIds);
  const currentRole = currentUserId ? userById.get(currentUserId)?.role : undefined;
  const marketplaceHandoffGuard = useAuthorityOperationGuard(
    client && connected && !connecting && currentUserId && currentRole
      ? [client, currentUserId, currentRole, authGeneration]
      : null
  );

  // Get actions from context
  const {
    onSendPrompt,
    onFork,
    onBtwFork,
    onOpenSettings,
    onUpdateSession,
    onOpenTerminal,
    onChooseAgenticTool,
    availableAgents,
  } = useAppActions();

  const { archiveSession } = useSessionActions(client);

  // Click-to-edit session title, inline in the header — see render below.
  // Draft is seeded from the *explicit* title only (not the description
  // fallback getSessionDisplayTitle shows when unset), so entering edit mode
  // never accidentally "sets" a title from the first-prompt fallback text.
  const [editingTitle, setEditingTitle] = React.useState(false);
  const [titleHovered, setTitleHovered] = React.useState(false);
  const [titleDraft, setTitleDraft] = React.useState('');
  const titleInputRef = React.useRef<InputRef | null>(null);
  const startEditingTitle = React.useCallback(() => {
    setTitleDraft(session?.title ?? '');
    setEditingTitle(true);
  }, [session?.title]);
  const saveTitle = React.useCallback(() => {
    setEditingTitle(false);
    if (!session) return;
    const trimmed = titleDraft.trim();
    if (trimmed !== (session.title ?? '')) {
      onUpdateSession?.(session.session_id, { title: trimmed });
    }
  }, [session, titleDraft, onUpdateSession]);
  React.useEffect(() => {
    if (editingTitle) titleInputRef.current?.focus();
  }, [editingTitle]);

  // "Switch tool" — same underlying chooseAgenticTool action the quick-start
  // empty-state tiles use, just with `replacingSessionId` set. Only offered
  // on a session with zero tasks (never prompted yet): tool is a per-session
  // SDK choice baked into every task, so there's no safe way to change it
  // once a conversation exists — hide the affordance entirely rather than
  // let it fail or silently drop history. (See `canSwitchTool` /
  // `handleSwitchTool` below the early-return, once `session` is narrowed.)
  const [switchToolOpen, setSwitchToolOpen] = React.useState(false);
  // The tile the user just clicked, not a bare boolean — mirrors
  // `PendingToolChoicePanel`'s `choosingTool` so the grid highlights the tile
  // being switched *to* during the async request, not the session's current
  // (old) tool.
  const [switchingTool, setSwitchingTool] = React.useState<string | null>(null);

  // App renders this panel without a session key, so a route/back-forward
  // change swaps `session` in place instead of remounting. Reset the transient
  // title-edit and switch-tool UI when the session id changes so a draft title
  // or an open switch modal from the previous session can't bleed into (and
  // then act on) the next one.
  const titleStateSessionId = session?.session_id;
  const prevTitleStateSessionId = React.useRef(titleStateSessionId);
  React.useEffect(() => {
    if (prevTitleStateSessionId.current !== titleStateSessionId) {
      prevTitleStateSessionId.current = titleStateSessionId;
      setEditingTitle(false);
      setTitleDraft('');
      setSwitchToolOpen(false);
      setSwitchingTool(null);
    }
  }, [titleStateSessionId]);

  // Tool capabilities — drives which buttons are shown
  const activeAgenticTool =
    session && isAgenticToolName(session.agentic_tool) ? session.agentic_tool : undefined;
  const hasActiveAgenticTool = Boolean(activeAgenticTool);
  const toolCaps = activeAgenticTool ? AGENTIC_TOOL_CAPABILITIES[activeAgenticTool] : undefined;

  // Compute which session MCP servers need authentication
  const unauthedMcpServers = React.useMemo(() => {
    return sessionMcpServerIds
      .map((id) => mcpServerById.get(id))
      .filter((server) => mcpServerNeedsAuth(server, userAuthenticatedMcpServerIds))
      .map((server) => server!);
  }, [sessionMcpServerIds, mcpServerById, userAuthenticatedMcpServerIds]);

  // Shared single-draft storage (localStorage-backed to survive refreshes).
  // Aliased as stable callbacks because they're threaded through props and
  // effect deps below.
  const getDraft = React.useCallback(
    (sessionId: string) => getPromptDraft(currentUserId, sessionId),
    [currentUserId]
  );
  const saveDraft = React.useCallback(
    (sessionId: string, value: string) => savePromptDraft(currentUserId, sessionId, value),
    [currentUserId]
  );
  const deleteDraft = React.useCallback(
    (sessionId: string, expectedText?: string) =>
      deletePromptDraft(currentUserId, sessionId, expectedText),
    [currentUserId]
  );

  // Input value lives entirely inside PromptInput (local state).
  // The parent reads it imperatively via promptRef / inputValueRef — no
  // parent re-renders on keystrokes.
  const promptRef = React.useRef<PromptInputHandle>(null);
  const inputValueRef = React.useRef(session ? getDraft(session.session_id) : '');
  const [hasInput, setHasInput] = React.useState(() => !!inputValueRef.current.trim());
  const handleHasInputChange = React.useCallback((v: boolean) => setHasInput(v), []);
  const [marketplacePromptSuggestion, setMarketplacePromptSuggestion] =
    React.useState<MarketplacePromptSuggestionState | null>(null);
  const marketplaceSuggestionSessionId = session?.session_id;
  const marketplaceHandoffAuthorityRef = React.useRef({
    sessionId: marketplaceSuggestionSessionId,
    userId: currentUserId,
    role: currentRole,
    authGeneration,
  });
  marketplaceHandoffAuthorityRef.current = {
    sessionId: marketplaceSuggestionSessionId,
    userId: currentUserId,
    role: currentRole,
    authGeneration,
  };
  React.useSyncExternalStore(
    subscribeMarketplacePromptState,
    getMarketplacePromptStateRevision,
    getMarketplacePromptStateRevision
  );

  // Suggestions are tab-local presentation state, intentionally separate from
  // the cross-tab composer draft. Reading one can never write or clear text.
  React.useEffect(() => {
    if (!marketplaceSuggestionSessionId || !currentUserId || !currentRole) {
      setMarketplacePromptSuggestion(null);
      return;
    }
    setMarketplacePromptSuggestion(
      consumeMarketplacePromptSuggestionState(marketplaceSuggestionSessionId, {
        userId: currentUserId,
        role: currentRole,
        authGeneration,
      })
    );
  }, [authGeneration, currentRole, currentUserId, marketplaceSuggestionSessionId]);

  React.useLayoutEffect(() => {
    if (marketplaceSuggestionSessionId && (!currentUserId || !currentRole)) {
      discardMarketplaceOAuthAuthorityState(marketplaceSuggestionSessionId);
      setMarketplacePromptSuggestion(null);
    }
  }, [currentRole, currentUserId, marketplaceSuggestionSessionId]);

  const visibleMarketplaceSuggestion =
    marketplacePromptSuggestion &&
    marketplacePromptSuggestion.sessionId === marketplaceSuggestionSessionId &&
    marketplacePromptSuggestion.userId === currentUserId &&
    marketplacePromptSuggestion.role === currentRole &&
    marketplacePromptSuggestion.authGeneration === authGeneration &&
    isMarketplacePromptSuggestionCurrent(marketplacePromptSuggestion)
      ? marketplacePromptSuggestion
      : null;

  // Marketplace OAuth presents its starter prompt only after the durable grant
  // has been observed by the same authoritative store this panel uses. It is
  // never inserted into the shared draft: another tab's typed text therefore
  // wins without relying on a nonexistent localStorage compare-and-set.
  React.useEffect(() => {
    const operation = marketplaceHandoffGuard.begin();
    if (
      !marketplaceSuggestionSessionId ||
      !client ||
      !currentUserId ||
      !currentRole ||
      !operation.isCurrent()
    )
      return;
    const capturedAuthority = {
      sessionId: marketplaceSuggestionSessionId,
      userId: currentUserId,
      role: currentRole,
      authGeneration,
    };
    void claimMarketplaceOAuthPrompt({
      client,
      sessionId: marketplaceSuggestionSessionId,
      authenticatedServerIds: userAuthenticatedMcpServerIds,
      authority: { userId: currentUserId, role: currentRole, authGeneration },
      isCurrent: operation.isCurrent,
      isAuthorityCurrent: () => {
        const current = marketplaceHandoffAuthorityRef.current;
        return (
          current.sessionId === capturedAuthority.sessionId &&
          current.userId === capturedAuthority.userId &&
          current.role === capturedAuthority.role &&
          current.authGeneration === capturedAuthority.authGeneration
        );
      },
    }).then((suggestion) => {
      if (operation.isCurrent()) {
        const staged = consumeMarketplacePromptSuggestionState(marketplaceSuggestionSessionId, {
          userId: currentUserId,
          role: currentRole,
          authGeneration,
        });
        if (!staged && !suggestion) return;
        setMarketplacePromptSuggestion(staged ?? suggestion);
      }
    });
    return operation.cancel;
  }, [
    authGeneration,
    client,
    currentRole,
    currentUserId,
    marketplaceHandoffGuard,
    marketplaceSuggestionSessionId,
    userAuthenticatedMcpServerIds,
  ]);

  const dismissMarketplacePromptSuggestion = React.useCallback(() => {
    if (marketplaceSuggestionSessionId) {
      discardMarketplacePromptSuggestion(
        marketplaceSuggestionSessionId,
        undefined,
        marketplacePromptSuggestion?.attemptId
      );
    }
    setMarketplacePromptSuggestion(null);
  }, [marketplacePromptSuggestion?.attemptId, marketplaceSuggestionSessionId]);

  const insertMarketplacePromptSuggestion = React.useCallback(() => {
    if (
      !visibleMarketplaceSuggestion ||
      !isMarketplacePromptSuggestionCurrent(visibleMarketplaceSuggestion) ||
      !promptRef.current
    )
      return;
    // PromptInput.insertText appends to (and never replaces) the current
    // composer value. This mutation occurs only from this explicit click.
    promptRef.current.insertText(visibleMarketplaceSuggestion.prompt);
    dismissMarketplacePromptSuggestion();
  }, [dismissMarketplacePromptSuggestion, visibleMarketplaceSuggestion]);

  // getDefaultPermissionMode imported from @agor-live/client — canonical
  // per-tool defaults live in core's `getDefaultPermissionMode`. The local
  // shadow that used to live here was stale (missing gemini/opencode/copilot)
  // and silently drifted from the core definition.

  const initialPermissionMode: PermissionMode =
    session?.permission_config?.mode ??
    (session?.agentic_tool && isAgenticToolName(session.agentic_tool)
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
  const [effortLevel, setEffortLevel] = React.useState<EffortLevel | undefined>(
    session?.model_config?.effort ?? toolCaps?.defaultReasoningEffort
  );
  const [scrollToBottom, setScrollToBottom] = React.useState<(() => void) | null>(null);
  const [scrollToTop, setScrollToTop] = React.useState<(() => void) | null>(null);
  const [queuedTasks, setQueuedTasks] = React.useState<Task[]>([]);
  const [forkModalOpen, setForkModalOpen] = React.useState(false);
  const [spawnModalOpen, setSpawnModalOpen] = React.useState(false);
  const [uploadModalOpen, setUploadModalOpen] = React.useState(false);
  const [advancedUploadInitialFiles, setAdvancedUploadInitialFiles] = React.useState<File[]>([]);
  const [composerDropActive, setComposerDropActive] = React.useState(false);
  const [stopRequestInFlight, setStopRequestInFlight] = React.useState(false);
  const currentClientRef = React.useRef(client);
  currentClientRef.current = client;
  const [forceFailTarget, setForceFailTarget] = React.useState<{
    taskId: string;
    terminationRequestedAt: string;
  } | null>(null);
  const [forceFailConfirmation, setForceFailConfirmation] = React.useState('');
  const forceFailInputRef = React.useRef<InputRef | null>(null);
  const reactiveSessionId = session?.session_id ?? null;
  const { state: reactiveSessionState } = useSharedReactiveSession(client, reactiveSessionId, {
    enabled: open,
    // ConversationView retains the same lazy handle. Keeping the cache key
    // identical collapses duplicate Session bootstrap/reconnect reads while
    // preserving the transcript's latest-task hydration contract.
    reactiveOptions: { taskHydration: 'lazy' },
  });

  const tasks = reactiveSessionState?.tasks || EMPTY_TASKS;
  React.useEffect(() => {
    if (
      forceFailTarget &&
      !tasks.some(
        (task) =>
          task.task_id === forceFailTarget.taskId &&
          task.status === TaskStatus.STOPPING &&
          task.sdk_failure?.termination === 'unverified' &&
          task.termination_request?.requested_at === forceFailTarget.terminationRequestedAt
      )
    ) {
      setForceFailTarget(null);
      setForceFailConfirmation('');
    }
  }, [forceFailTarget, tasks]);
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
    ownerId: string | null;
    sessionId: SessionID | null;
    generation: number;
    ownerGeneration: number;
  }>({
    ownerId: currentUserId ?? null,
    sessionId: session?.session_id ?? null,
    generation: 0,
    ownerGeneration: 0,
  });
  const currentComposerOwnerId = currentUserId ?? null;
  const currentComposerSessionId = session?.session_id ?? null;
  if (
    composerSessionIdentityRef.current.ownerId !== currentComposerOwnerId ||
    composerSessionIdentityRef.current.sessionId !== currentComposerSessionId
  ) {
    composerSessionIdentityRef.current = {
      ownerId: currentComposerOwnerId,
      sessionId: currentComposerSessionId,
      generation: composerSessionIdentityRef.current.generation + 1,
      ownerGeneration:
        composerSessionIdentityRef.current.ownerId === currentComposerOwnerId
          ? composerSessionIdentityRef.current.ownerGeneration
          : composerSessionIdentityRef.current.ownerGeneration + 1,
    };
  }
  const composerIdentityKey = `${currentComposerOwnerId ?? 'anonymous'}:${composerSessionIdentityRef.current.generation}:${currentComposerSessionId ?? 'none'}`;
  const {
    attachments: composerAttachments,
    attachmentsRef: composerAttachmentsRef,
    clearAttachments: clearComposerAttachments,
    hasAttachments: hasComposerAttachments,
    addAttachments: addComposerAttachments,
    removeAttachment: removeComposerAttachment,
    uploadAttachments: uploadComposerAttachments,
    uploading: composerAttachmentUploading,
    uploadingRef: composerAttachmentUploadingRef,
    validationError: composerAttachmentValidationError,
    setValidationError: setComposerAttachmentValidationError,
  } = useComposerAttachments({
    sessionId: session?.session_id ?? null,
    scopeKey: composerIdentityKey,
    showError,
    uploadPolicy,
  });
  const composerSendInFlightRef = React.useRef<typeof composerSessionIdentityRef.current | null>(
    null
  );

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
        const { contextWindowLimit, contextUsageSnapshot } = task.normalized_sdk_response;

        if (task.computed_context_window > 0) {
          return {
            used: task.computed_context_window,
            limit: contextUsageSnapshot?.maxTokens ?? contextWindowLimit ?? 0,
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

  const attachmentItems = React.useMemo((): SessionAttachmentItem[] => {
    const acc: SessionAttachmentItem[] = [];
    if (branch?.issue_url) {
      acc.push({
        key: 'issue',
        name: `Issue: ${getUrlDisplayLabel(branch.issue_url)}`,
        url: branch.issue_url,
      });
    }
    if (branch?.pull_request_url) {
      acc.push({
        key: 'pr',
        name: `PR: ${getUrlDisplayLabel(branch.pull_request_url)}`,
        url: branch.pull_request_url,
      });
    }
    return acc;
  }, [branch?.issue_url, branch?.pull_request_url]);

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
        candidate.status === TaskStatus.DISPATCHING ||
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
    } else if (session?.agentic_tool && isAgenticToolName(session.agentic_tool)) {
      setPermissionMode(getDefaultPermissionMode(session.agentic_tool));
    }

    if (session?.agentic_tool === 'codex' && session?.permission_config?.codex) {
      setCodexSandboxMode(session.permission_config.codex.sandboxMode);
      setCodexApprovalPolicy(session.permission_config.codex.approvalPolicy);
    }
  }, [session?.permission_config?.mode, session?.permission_config?.codex, session?.agentic_tool]);

  // Keep explicit overrides distinct from runtime-owned defaults (for example Codex config.toml).
  React.useEffect(() => {
    setEffortLevel(session?.model_config?.effort ?? toolCaps?.defaultReasoningEffort);
  }, [session?.model_config?.effort, toolCaps?.defaultReasoningEffort]);

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && searchOpen) closeSearch();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [searchOpen, closeSearch]);

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
    onModelConfigCommit: (config: ModelConfig) => void;
    onSendPrompt: () => void;
    onStop: () => void;
    onFork: () => void;
    onBtwSend: () => void;
    onSpawnOpen: () => void;
    onAttachFiles: () => void;
    onUploadOpen: () => void;
    onEffortChange: (v: EffortLevel | undefined) => void;
    onPermissionModeChange: (v: PermissionMode) => void;
    onCodexPermissionChange: (sandbox: CodexSandboxMode, approval: CodexApprovalPolicy) => void;
  } | null>(null);
  const stableFooterHandlers = React.useMemo(
    () => ({
      onModelConfigCommit: (config: ModelConfig) =>
        footerHandlersRef.current?.onModelConfigCommit(config),
      onSendPrompt: () => footerHandlersRef.current?.onSendPrompt(),
      onStop: () => footerHandlersRef.current?.onStop(),
      onFork: () => footerHandlersRef.current?.onFork(),
      onBtwSend: () => footerHandlersRef.current?.onBtwSend(),
      onSpawnOpen: () => footerHandlersRef.current?.onSpawnOpen(),
      onAttachFiles: () => footerHandlersRef.current?.onAttachFiles(),
      onUploadOpen: () => footerHandlersRef.current?.onUploadOpen(),
      onEffortChange: (v: EffortLevel | undefined) => footerHandlersRef.current?.onEffortChange(v),
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
      <>
        {visibleMarketplaceSuggestion && (
          <MarketplacePromptSuggestion
            prompt={visibleMarketplaceSuggestion.prompt}
            isCurrent={() =>
              isMarketplacePromptSuggestionCurrent(visibleMarketplaceSuggestion) &&
              visibleMarketplaceSuggestion.sessionId === marketplaceSuggestionSessionId &&
              visibleMarketplaceSuggestion.userId === currentUserId &&
              visibleMarketplaceSuggestion.role === currentRole &&
              visibleMarketplaceSuggestion.authGeneration === authGeneration
            }
            onInsert={insertMarketplacePromptSuggestion}
            onDismiss={dismissMarketplacePromptSuggestion}
            style={{ marginBottom: token.marginXS, borderRadius: token.borderRadius }}
          />
        )}
        <SessionComposerDropZone
          disabled={composerAttachmentUploading}
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
            disabled={composerAttachmentUploading}
            onRemove={removeComposerAttachment}
          />
          <PromptInput
            key={composerIdentityKey}
            ref={promptRef}
            sessionId={session.session_id}
            getDraft={getDraft}
            saveDraft={saveDraft}
            deleteDraft={deleteDraft}
            onHasInputChange={handleHasInputChange}
            inputValueRef={inputValueRef}
            onSubmit={stableFooterHandlers.onSendPrompt}
            hasExternalInput={hasComposerAttachments}
            placeholder={
              isRunning
                ? 'Queue here… @ for mentions, : for emoji'
                : 'Prompt here… @ for mentions, : for emoji'
            }
            autoSize={{ minRows: 1, maxRows: 10 }}
            client={client}
            userById={userById}
            onFilesDrop={addComposerAttachments}
            filesDropDisabled={composerAttachmentUploading}
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
            disabled={composerAttachmentUploading}
            style={{ display: 'none' }}
            onChange={(event) => {
              addComposerAttachments(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
        </SessionComposerDropZone>
      </>
    );
  }, [
    session,
    sessionCustomContext,
    composerAttachmentUploading,
    composerAttachmentValidationError,
    composerAttachments,
    composerDropActive,
    composerIdentityKey,
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
    token.marginXS,
    visibleMarketplaceSuggestion,
    marketplaceSuggestionSessionId,
    currentUserId,
    currentRole,
    authGeneration,
    dismissMarketplacePromptSuggestion,
    insertMarketplacePromptSuggestion,
  ]);

  // When there's no session, render nothing (panel is collapsed to zero).
  // When open=false, we still render the component tree (hidden) so that
  // antd's CSS-in-JS doesn't garbage-collect component styles.
  if (!session) {
    return null;
  }
  const activeSession = isAgenticToolName(session.agentic_tool)
    ? (session as Session & { agentic_tool: AgenticToolName })
    : null;

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
  const canSwitchTool =
    hasActiveAgenticTool && !!branch && !!onChooseAgenticTool && (session.tasks?.length ?? 0) === 0;
  const handleSwitchTool = async (tool: string) => {
    if (!branch || !onChooseAgenticTool || switchingTool) return;
    setSwitchingTool(tool);
    try {
      await onChooseAgenticTool(branch.branch_id, tool as AgenticToolName, session.session_id);
      setSwitchToolOpen(false);
    } finally {
      setSwitchingTool(null);
    }
  };
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
            label: 'Session settings',
            onClick: () => onOpenSettings(session.session_id),
          },
        ]
      : []),
    ...(canSwitchTool
      ? [
          {
            key: 'switch-tool',
            icon: <RobotOutlined />,
            label: 'Switch tool…',
            onClick: () => setSwitchToolOpen(true),
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
    if (composerAttachmentUploadingRef.current) return;
    setAdvancedUploadInitialFiles(initialFiles);
    setUploadModalOpen(true);
  };

  const handleSendPrompt = async () => {
    const sendStartComposerIdentity = composerSessionIdentityRef.current;
    if (
      composerSendInFlightRef.current === sendStartComposerIdentity ||
      composerAttachmentUploadingRef.current ||
      connectionDisabled
    ) {
      return;
    }

    composerSendInFlightRef.current = sendStartComposerIdentity;
    try {
      const sendStartSessionId = session.session_id;
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
      const currentComposerIdentity = composerSessionIdentityRef.current;
      if (
        currentComposerIdentity.ownerId !== sendStartComposerIdentity.ownerId ||
        currentComposerIdentity.ownerGeneration !== sendStartComposerIdentity.ownerGeneration
      ) {
        return;
      }
      const promptAttachments = uploadedFiles;
      const composerStillOwnsSend =
        composerSessionIdentityRef.current === sendStartComposerIdentity;
      // Re-read from the imperative textarea handle after upload only if the
      // same composer instance still owns this send. When the user switches
      // sessions during a delayed upload, promptRef points at the newly active
      // composer; reading/clearing it would mix the new prompt into the old
      // session. In that case we send the original snapshot to the original
      // session and preserve the active composer's text/attachments.
      const latestValue = composerStillOwnsSend
        ? getLatestComposerPromptText({
            promptHandle: promptRef.current,
            inputValueRefValue: inputValueRef.current,
            sendStartValue: value,
          })
        : value;
      const promptToSend = buildPromptWithAttachments(latestValue, promptAttachments);
      if (!promptToSend.trim()) return;

      // Single entry point: /prompt. The daemon decides run-vs-queue based on
      // session state and reports it back via `task.status`. The 'queued'
      // WebSocket event populates the queue panel for queued prompts.
      const sendResult = await onSendPrompt?.(sendStartSessionId, promptToSend, permissionMode);
      if (sendResult === false) return;

      // Admission can outlive this composer. Re-check ownership after the
      // await rather than reusing the pre-admission snapshot: a later caller
      // may have typed identical text and selected different attachments.
      const composerOwnsAdmissionCompletion =
        composerSessionIdentityRef.current === sendStartComposerIdentity;
      const composerStillOwnsSentText =
        composerOwnsAdmissionCompletion && promptRef.current?.getValue() === latestValue;
      if (composerStillOwnsSentText) {
        promptRef.current?.clear();
        clearComposerAttachments();
        setComposerAttachmentValidationError(null);
      } else {
        // The composer moved or its text changed while admission was pending.
        // Clear only an exactly matching persisted snapshot; never erase the
        // replacement text now visible to the user.
        deleteDraft(sendStartSessionId, latestValue);
      }

      // Re-engage the bottom lock so a scrolled-up user follows their just-sent
      // message and the streaming reply (behavior 3). `scrollToBottom` is the
      // function ConversationView exposed via onScrollRef.
      if (composerOwnsAdmissionCompletion) scrollToBottom?.();
    } catch (error) {
      if (composerSessionIdentityRef.current !== sendStartComposerIdentity) return;
      console.error('Composer send failed — keeping prompt and files in composer:', error);
      showError(error instanceof Error ? error.message : 'Failed to send prompt');
    } finally {
      if (composerSendInFlightRef.current === sendStartComposerIdentity) {
        composerSendInFlightRef.current = null;
      }
    }
  };

  const handleStop = async () => {
    if (!session || !client || connectionDisabled || stopRequestInFlight) return;

    const unverifiedTask = [...tasks]
      .reverse()
      .find(
        (task) =>
          task.status === TaskStatus.STOPPING && task.sdk_failure?.termination === 'unverified'
      );
    if (unverifiedTask?.termination_request) {
      setForceFailConfirmation('');
      setForceFailTarget({
        taskId: unverifiedTask.task_id,
        terminationRequestedAt: unverifiedTask.termination_request.requested_at,
      });
      return;
    }

    // Show feedback immediately if this is a retry
    if (isStopping) {
      showInfo('Retrying stop request...');
    }

    const stopSessionId = session.session_id;
    const stopTarget = [...tasks]
      .reverse()
      .find(
        (task) =>
          task.status === TaskStatus.DISPATCHING ||
          task.status === TaskStatus.RUNNING ||
          task.status === TaskStatus.STOPPING ||
          task.status === TaskStatus.AWAITING_PERMISSION ||
          task.status === TaskStatus.AWAITING_INPUT
      );
    if (!stopTarget) {
      showError('Execution state is still syncing. Try again.');
      return;
    }

    setStopRequestInFlight(true);
    try {
      const result: SessionStopResult = await requestSessionStop(
        client,
        stopSessionId,
        stopTarget.task_id
      );
      if (result.success === false) {
        showInfo(result.reason ?? 'Stop requested; waiting for executor termination.');
      }
    } catch (error) {
      console.error('Failed to stop execution:', error);
      const reconciliation = isStopTransportAmbiguous(error)
        ? await reconcileStopTransportFailure(
            () => currentClientRef.current,
            stopSessionId,
            stopTarget.task_id
          )
        : { outcome: 'unresolved' as const };
      if (reconciliation.outcome === 'accepted' || reconciliation.outcome === 'ended') {
        showInfo(reconciliation.reason);
      } else {
        showError('Failed to stop execution. You can try again.');
      }
    } finally {
      setStopRequestInFlight(false);
    }
  };

  const handleForceFail = async () => {
    if (
      !session ||
      !client ||
      !forceFailTarget ||
      forceFailConfirmation !== 'STOP' ||
      stopRequestInFlight
    ) {
      return;
    }
    setStopRequestInFlight(true);
    try {
      await client.service(`sessions/${session.session_id}/stop`).create({
        force_unverified: true,
        confirmation: 'STOP',
        task_id: forceFailTarget.taskId,
        termination_requested_at: forceFailTarget.terminationRequestedAt,
      });
      setForceFailTarget(null);
      setForceFailConfirmation('');
    } catch (error) {
      console.error('Failed to force-fail execution:', error);
      showError('Failed to force-fail execution. You can try again.');
    } finally {
      setStopRequestInFlight(false);
    }
  };

  const handleFork = async () => {
    if (!session) return;
    if (composerAttachmentsRef.current.length > 0) {
      showError(
        'Attachments are only supported for normal Send for now. Remove attachments to fork.'
      );
      return;
    }
    const value = promptRef.current?.getValue() ?? '';
    const promptToSend = value.trim();
    if (!promptToSend) {
      setForkModalOpen(true);
      return;
    }
    try {
      await onFork?.(session.session_id, promptToSend);
      // Only clear the compose box + draft on success, so a failed fork
      // leaves the typed prompt intact for the user to retry.
      promptRef.current?.clear();
    } catch (error) {
      console.error('Fork failed — keeping prompt in compose box:', error);
    }
  };

  const handleForkModalConfirm = async (config: string | Partial<SpawnConfig>) => {
    if (!session) return;
    const prompt = typeof config === 'string' ? config : (config.prompt ?? '');
    if (!prompt) return;
    await onFork?.(session.session_id, prompt);
  };

  const handleBtwSend = async () => {
    if (composerAttachmentsRef.current.length > 0) {
      showError(
        'Attachments are only supported for normal Send for now. Remove attachments to send BTW.'
      );
      return;
    }
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

  const handleSpawnOpen = () => {
    if (composerAttachmentsRef.current.length > 0) {
      showError(
        'Attachments are only supported for normal Send for now. Remove attachments to spawn.'
      );
      return;
    }
    setSpawnModalOpen(true);
  };

  const handleSpawnModalConfirm = async (config: string | Partial<SpawnConfig>) => {
    if (!session || !client) return;

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
            presetId: config.presetId,
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

    await client
      .service(`sessions/${session.session_id}/spawn-prompt`)
      .create({ ...spawnConfig, parentPermissionMode: permissionMode });

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

  const handleEffortChange = (newEffort: EffortLevel | undefined) => {
    setEffortLevel(newEffort);

    if (session?.model_config && onUpdateSession) {
      const nextModelConfig = {
        ...session.model_config,
        updated_at: new Date().toISOString(),
      };
      if (newEffort) nextModelConfig.effort = newEffort;
      else delete nextModelConfig.effort;
      onUpdateSession(session.session_id, { model_config: nextModelConfig });
    }
  };

  const handleModelConfigCommit = (newConfig: ModelConfig) => {
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
    onModelConfigCommit: handleModelConfigCommit,
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

  const sessionFooter = activeSession ? (
    <SessionFooter
      session={activeSession}
      currentUserId={currentUserId}
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
      composerAttachmentUploading={composerAttachmentUploading}
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
      onModelConfigCommit={stableFooterHandlers.onModelConfigCommit}
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
  ) : null;

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
              {editingTitle ? (
                <Input
                  ref={titleInputRef}
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={saveTitle}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      saveTitle();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setEditingTitle(false);
                    }
                  }}
                  placeholder="Untitled session"
                  variant="borderless"
                  style={{ fontSize: 18, fontWeight: 600, padding: 0 }}
                />
              ) : (
                <Tooltip title="Click to rename">
                  <button
                    type="button"
                    onClick={startEditingTitle}
                    onMouseEnter={() => setTitleHovered(true)}
                    onMouseLeave={() => setTitleHovered(false)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      maxWidth: '100%',
                      cursor: 'text',
                      borderRadius: token.borderRadiusSM,
                      padding: '2px 6px',
                      margin: '-2px -6px',
                      background: titleHovered ? token.colorFillTertiary : 'transparent',
                      transition: 'background 0.15s',
                      border: 'none',
                      font: 'inherit',
                      color: 'inherit',
                      textAlign: 'left',
                    }}
                  >
                    <Typography.Text strong style={{ fontSize: 18, ...getSessionTitleStyles(2) }}>
                      {session.title || session.description
                        ? getSessionDisplayTitle(session, { includeAgentFallback: false })
                        : 'Untitled session'}
                    </Typography.Text>
                    <EditOutlined
                      style={{
                        fontSize: 12,
                        color: token.colorTextTertiary,
                        opacity: titleHovered ? 1 : 0,
                        transition: 'opacity 0.15s',
                        flexShrink: 0,
                      }}
                    />
                  </button>
                </Tooltip>
              )}
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
            <SessionAttachmentsDropdown items={attachmentItems} />
            <Dropdown menu={{ items: moreMenuItems }} trigger={['click']} placement="bottomRight">
              <Tooltip title="More actions">
                <Button type="text" icon={<EllipsisOutlined />} />
              </Tooltip>
            </Dropdown>
            <Tooltip title="Search session">
              <Button
                type="text"
                aria-label="Search session"
                icon={<SearchOutlined />}
                onClick={openSearch}
              />
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
          {!hasActiveAgenticTool && (
            <Alert
              type="warning"
              showIcon
              message="Historical session — runtime removed"
              description="This session used the removed experimental Claude Code CLI integration. Its stored conversation remains readable, but it cannot be prompted, resumed, forked, spawned from, or restarted."
              style={{ marginBottom: token.marginSM }}
            />
          )}
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
            setSpawnModalOpen={setSpawnModalOpen}
            onSpawnModalConfirm={handleSpawnModalConfirm}
            inputValueRef={inputValueRef}
            isOpen={open}
            forceExpandAll={searchOpen && query.trim().length > 0}
          />
        </div>

        {/* Footer is unavailable for historical sessions whose runtime was removed. */}
        {sessionFooter}

        <Modal
          title="Force-fail task?"
          open={forceFailTarget !== null}
          okText="Force fail"
          cancelText="Cancel"
          keyboard
          mask={{ closable: false }}
          confirmLoading={stopRequestInFlight}
          okButtonProps={{
            danger: true,
            disabled: forceFailConfirmation !== 'STOP',
          }}
          cancelButtonProps={{ disabled: stopRequestInFlight }}
          onOk={handleForceFail}
          onCancel={() => {
            if (stopRequestInFlight) return;
            setForceFailTarget(null);
            setForceFailConfirmation('');
          }}
          afterOpenChange={(modalOpen) => {
            if (modalOpen) forceFailInputRef.current?.focus();
          }}
        >
          <Alert
            type="warning"
            showIcon
            title="Executor termination is unverified"
            description="The executor may still be running and writing to this branch. Force-fail changes Agor's durable Task status to failed and makes the Session available again. It cannot prove or guarantee process termination."
            style={{ marginBottom: token.marginMD }}
          />
          <Typography.Paragraph>
            Type <Typography.Text code>STOP</Typography.Text> to continue.
          </Typography.Paragraph>
          <Input
            ref={forceFailInputRef}
            aria-label="Type STOP to confirm force-fail"
            value={forceFailConfirmation}
            onChange={(event) => setForceFailConfirmation(event.target.value)}
            onPressEnter={() => {
              if (forceFailConfirmation === 'STOP') void handleForceFail();
            }}
            disabled={stopRequestInFlight}
            autoComplete="off"
          />
        </Modal>

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
          onCancel={() => setForkModalOpen(false)}
          client={client}
          userById={userById}
        />

        {/* Switch tool — same tile picker as the quick-start empty state,
            just replacing this (never-prompted) session instead of creating
            the first one. Only reachable via moreMenuItems when canSwitchTool. */}
        <Modal
          title="Switch tool"
          open={switchToolOpen}
          onCancel={() => setSwitchToolOpen(false)}
          footer={null}
        >
          <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
            Choose a different tool for this session. Since nothing has been sent yet, this replaces
            the session in place.
          </Typography.Paragraph>
          <div style={{ position: 'relative' }}>
            <AgentSelectionGrid
              agents={availableAgents ?? []}
              selectedAgentId={switchingTool}
              onSelect={handleSwitchTool}
              columns={2}
            />
            {switchingTool && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: token.colorBgElevated,
                  opacity: 0.7,
                }}
              >
                <Spin size="small" />
              </div>
            )}
          </div>
        </Modal>
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
