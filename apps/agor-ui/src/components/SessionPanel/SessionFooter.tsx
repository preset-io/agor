import type { ContextUsageSnapshot } from '@agor/core/types';
import { GEMINI_MANUAL_MESSAGE, isGeminiManualMode } from '@agor/core/utils/permission-mode-mapper';
import type {
  AgenticToolCapabilities,
  AgenticToolName,
  AgorClient,
  CodexApprovalPolicy,
  CodexSandboxMode,
  EffortLevel,
  MCPServer,
  PermissionMode,
  Session,
  Task,
} from '@agor-live/client';
import {
  getDefaultModelForTool,
  getDefaultPermissionMode,
  mapToCodexPermissionConfig,
  SessionStatus,
  shortId,
} from '@agor-live/client';
import {
  ApiOutlined,
  ArrowUpOutlined,
  BranchesOutlined,
  ClockCircleOutlined,
  CopyOutlined,
  ExperimentOutlined,
  ForkOutlined,
  IdcardOutlined,
  InfoCircleOutlined,
  LoadingOutlined,
  LockOutlined,
  NumberOutlined,
  PaperClipOutlined,
  PieChartOutlined,
  PlusOutlined,
  QuestionCircleOutlined,
  SettingOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import type { ButtonProps } from 'antd';
import {
  Badge,
  Button,
  ConfigProvider,
  Divider,
  Flex,
  Progress,
  Segmented,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import React from 'react';
import { setComposerFocused } from '../../hooks/useComposerFocus';
import { useElementWidth } from '../../hooks/useElementWidth';
import { COMPACT_PIN_LIMIT, useFooterPreferences } from '../../hooks/useFooterPreferences';
import { useIsMobileViewport } from '../../hooks/useIsMobileViewport';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { useSessionUsage } from '../../hooks/useSessionUsage';
import { copyToClipboard } from '../../utils/clipboard';
import { LOST_CONNECTION_TOOLTIP } from '../../utils/connectionErrors';
import { getContextWindowColor, resolveContextWindowPercentage } from '../../utils/contextWindow';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { useThemedMessage } from '../../utils/message';
import { CompactNotice } from '../CompactNotice';
import { EFFORT_OPTIONS } from '../EffortSelector';
import { glassSurfaceStyle } from '../GlassSurface/glassStyles';
import { summarizeSessionMcpServers } from '../MCPServer/mcp-session-summary';
import type { ModelConfig } from '../ModelSelector';
import { ModelSelector } from '../ModelSelector';
import {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  getPermissionModeLabel,
  getPermissionModeMeta,
  getPermissionModes,
} from '../PermissionModeSelector';
import { getModelChipLabel } from '../Pill/modelDisplay';
import { ContextWindowPopoverContent } from '../Pill/Pill';
import { TimerDetails, useElapsedDuration } from '../Pill/TimerPill';
import {
  ComposerMenu,
  ComposerMenuBack,
  ComposerMenuNote,
  ComposerMenuRow,
  ComposerMenuSection,
  ComposerPinToggle,
} from './ComposerMenu';
import {
  getComposerCircleState,
  isPermissionNonDefault,
  NARROW_COMPOSER_WIDTH,
  NARROW_PIN_LIMIT,
  splitPinnedActions,
} from './composerState';
import { RecoveryActions } from './RecoveryActions';
import { SessionComposerDropZone } from './SessionComposerDropZone';
import { SessionMcpFooterControl } from './SessionMcpFooterControl';
import { SessionUsageSummary } from './SessionUsagePopover';

export interface SessionFooterProps {
  // Session data for chips
  session: Session & { agentic_tool: AgenticToolName };
  currentUserId?: string;
  footerTimerTask: Task | null;
  latestContextWindow: { used: number; limit: number; taskMetadata: unknown } | null;
  // MCP data for Tools chip
  sessionMcpServerIds: string[];
  sessionMcpLoadFailed?: boolean;
  onSessionMcpRetry?: () => void;
  unauthedMcpServers: MCPServer[];
  mcpServerById: Map<string, MCPServer>;
  userAuthenticatedMcpServerIds: Set<string>;
  // Action state
  isRunning: boolean;
  isStopping: boolean;
  stopRequestInFlight: boolean;
  recoveryTask?: Task;
  recoveryError?: string | null;
  canReopenSession?: boolean;
  onRetryCleanup?: () => void;
  hasInput: boolean;
  composerAttachmentsPresent?: boolean;
  composerAttachmentUploading?: boolean;
  connectionDisabled: boolean;
  toolCaps?: AgenticToolCapabilities;
  // Settings state
  effortLevel?: EffortLevel;
  permissionMode: PermissionMode;
  codexSandboxMode: CodexSandboxMode;
  codexApprovalPolicy: CodexApprovalPolicy;
  queuedTasks: Task[];
  client: AgorClient | null;
  modelLabel?: string;
  modelConfig?: ModelConfig;
  // Handlers
  onModelConfigCommit: (config: ModelConfig) => void;
  onOpenSessionSettings?: (sessionId: string) => void;
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
  /** Attachment tray and text, rendered inside the card. */
  promptInputSlot: React.ReactNode;
  /** Queued messages, shown above the card. */
  queueSlot?: React.ReactNode;
  /** Files dropped anywhere on the card. */
  onFilesDrop: (files: File[]) => void;
  onDropActiveChange?: (active: boolean) => void;
}

type ComposerMenuId = 'plus' | 'model' | 'permissions' | 'details' | 'mcp';
/** Session details rows an info-line segment can open on. */
type DetailRow = 'timer' | 'tools' | 'usage' | 'context' | 'session-ids';
/** Session details rows whose breakdown expands inline. */
type ExpandableRow = 'timer' | 'usage' | 'context';
const isExpandableRow = (row: DetailRow | null): row is ExpandableRow =>
  row === 'timer' || row === 'usage' || row === 'context';
interface InfoSegment {
  key: string;
  row: DetailRow | null;
  label: React.ReactNode;
  ariaLabel: string;
  tooltip: React.ReactNode;
  warning?: boolean;
}

const formatTokenCount = (count: number) =>
  count >= 1000 ? `${(count / 1000).toFixed(count >= 100_000 ? 0 : 1)}k` : String(count);

/** Visible size of the phone circle; its touch target stays 44px. */
const CIRCLE_VISUAL_COMPACT = 36;

const PINNABLE_ACTIONS = ['upload', 'advanced-upload', 'fork', 'btw-fork', 'spawn', 'mcp'];

// Memoized: the panel re-renders once per animation frame while its session
// streams (reactive-session notifies), and this footer is a large subtree of
// dropdowns/popovers that doesn't depend on per-chunk state. SessionPanel
// keeps every prop identity-stable across those renders (stable handler
// wrappers, memoized slot/config objects) so the bailout actually holds.
const SessionFooterInner: React.FC<SessionFooterProps> = ({
  session,
  currentUserId,
  footerTimerTask,
  latestContextWindow,
  sessionMcpServerIds,
  sessionMcpLoadFailed = false,
  onSessionMcpRetry,
  unauthedMcpServers,
  mcpServerById,
  userAuthenticatedMcpServerIds,
  isRunning,
  isStopping,
  stopRequestInFlight,
  recoveryTask,
  recoveryError,
  canReopenSession,
  onRetryCleanup,
  hasInput,
  composerAttachmentsPresent = false,
  composerAttachmentUploading = false,
  connectionDisabled,
  toolCaps,
  queuedTasks,
  effortLevel,
  permissionMode,
  codexSandboxMode,
  codexApprovalPolicy,
  client,
  modelLabel,
  modelConfig,
  onModelConfigCommit,
  onOpenSessionSettings,
  onSendPrompt,
  onStop,
  onFork,
  onBtwSend,
  onSpawnOpen,
  onAttachFiles,
  onUploadOpen,
  onEffortChange,
  onPermissionModeChange,
  onCodexPermissionChange,
  promptInputSlot,
  queueSlot,
  onFilesDrop,
  onDropActiveChange,
}) => {
  const managedByPreset = Boolean(session.agentic_tool_preset_id);
  const supportsLiveEffort = Boolean(toolCaps?.reasoningEffortLevels?.length);
  const { token } = theme.useToken();
  const { showSuccess } = useThemedMessage();
  // One card at every width: phones get 44px targets and bottom sheets,
  // desktop gets 32px controls and popovers anchored to their trigger.
  const isMobile = useIsMobileViewport();
  const reducedMotion = usePrefersReducedMotion();
  const cardRef = React.useRef<HTMLDivElement>(null);
  const cardWidth = useElementWidth(cardRef);
  const narrow = !isMobile && cardWidth > 0 && cardWidth < NARROW_COMPOSER_WIDTH;
  const [cardFocused, setCardFocused] = React.useState(false);
  const [textFocused, setTextFocused] = React.useState(false);
  // On phones the tab bar hides while the text has focus; the composer then owns the bottom inset.
  // Only the text field counts: a tapped button must not shift the row mid-tap.
  const keyboardUp = isMobile && textFocused;
  React.useEffect(() => {
    setComposerFocused(keyboardUp);
  }, [keyboardUp]);
  React.useEffect(() => () => setComposerFocused(false), []);
  const [prefs, setPref] = useFooterPreferences();
  const pinKey = isMobile ? 'pinnedItemsCompact' : 'pinnedItems';
  const pinnedItems = prefs[pinKey];
  const availableActions = PINNABLE_ACTIONS.filter((id) =>
    id === 'fork' || id === 'btw-fork'
      ? toolCaps?.supportsSessionFork !== false
      : id === 'spawn'
        ? toolCaps?.supportsChildSpawn !== false
        : true
  );
  // A crowded narrow or phone row folds its last pins first, so the chips and Queue stay readable.
  const [crowdFold, setCrowdFold] = React.useState(0);
  const pinLimit = isMobile ? COMPACT_PIN_LIMIT : narrow ? NARROW_PIN_LIMIT : undefined;
  const pinnedCount = availableActions.filter((id) => pinnedItems.includes(id)).length;
  const { row: rowPins, folded: foldedPins } = splitPinnedActions(
    pinnedItems,
    availableActions,
    pinLimit === undefined ? undefined : Math.max(0, Math.min(pinLimit, pinnedCount) - crowdFold)
  );
  const togglePin = (id: string) => {
    if (pinnedItems.includes(id)) {
      setPref({ [pinKey]: pinnedItems.filter((p) => p !== id) });
    } else if (!isMobile || pinnedItems.length < COMPACT_PIN_LIMIT) {
      setPref({ [pinKey]: [...pinnedItems, id] });
    }
  };
  const pinnedChips = prefs.pinnedChips;
  const toggleChip = (id: string) => {
    setPref({
      pinnedChips: pinnedChips.includes(id)
        ? pinnedChips.filter((c) => c !== id)
        : [...pinnedChips, id],
    });
  };

  // A new session resolves its model at runtime, so the chip falls back to the tool default.
  const effectiveModel =
    session.model_config?.model ?? getDefaultModelForTool(session.agentic_tool);
  const elapsed = useElapsedDuration({
    status: footerTimerTask?.status ?? 'pending',
    startedAt: footerTimerTask?.message_range?.start_timestamp || footerTimerTask?.created_at,
    endedAt: footerTimerTask?.message_range?.end_timestamp || footerTimerTask?.completed_at,
    durationMs: footerTimerTask?.duration_ms,
  });
  const workingElapsed = elapsed.hasTiming ? <span>· {elapsed.label}</span> : null;

  // Signature of the currently-disconnected servers. Dismissal is keyed by it,
  // so hiding the notice sticks — until a *different* server disconnects, which
  // changes the signature and surfaces the nudge again.
  const unauthedSignature = React.useMemo(
    () =>
      unauthedMcpServers
        .map((s) => s.mcp_server_id)
        .sort()
        .join(','),
    [unauthedMcpServers]
  );
  const [dismissedMcpSignature, setDismissedMcpSignature] = useLocalStorage<string | null>(
    `agor-mcp-banner-dismissed:${session.session_id}`,
    null
  );
  const showMcpNotice =
    unauthedMcpServers.length > 0 && dismissedMcpSignature !== unauthedSignature;
  const mcpNoticeMessage =
    unauthedMcpServers.length === 1
      ? `${unauthedMcpServers[0].display_name || unauthedMcpServers[0].name} isn’t connected. Open Session details to connect it.`
      : `${unauthedMcpServers.length} MCP servers aren’t connected. Open Session details to connect them.`;

  const composerAttachmentActionTooltip = 'Attachments only work with Send for now';
  const composerUploadTooltip = 'Uploading files...';
  const uploadDisabled = connectionDisabled || composerAttachmentUploading;
  const advancedUploadDisabled = uploadDisabled;
  const forkDisabled = connectionDisabled || composerAttachmentsPresent;
  const btwForkDisabled = connectionDisabled || !hasInput || composerAttachmentsPresent;
  const spawnDisabled = connectionDisabled || isRunning || composerAttachmentsPresent;
  const sendDisabled = connectionDisabled || composerAttachmentUploading || !hasInput;

  const stopTooltip = connectionDisabled
    ? LOST_CONNECTION_TOOLTIP
    : stopRequestInFlight
      ? 'Stopping...'
      : isStopping
        ? 'Agor is checking that the previous work has stopped.'
        : 'Stop';

  const recoveryFailed = recoveryTask?.sdk_failure?.termination === 'unverified';
  const showStop = !recoveryFailed && (isRunning || stopRequestInFlight);
  const stopBusy = stopRequestInFlight || isStopping;
  const stopDisabled = connectionDisabled || !isRunning || stopBusy;
  // isRunning also includes stopping for the action controls. Only advertise
  // active work here, not permission/input waits or a stale offline state.
  const showActivity =
    session.status === SessionStatus.RUNNING && !stopRequestInFlight && !connectionDisabled;

  const circleState = getComposerCircleState({ stopAvailable: showStop, isRunning, hasInput });
  const queuedCount = queuedTasks.length;
  const circleLabel = `${
    circleState === 'stop' ? 'Stop' : circleState === 'queue' ? 'Queue message' : 'Send'
  }${queuedCount > 0 ? `, ${queuedCount} queued` : ''}`;
  const circleDisabled = circleState === 'stop' ? stopDisabled : sendDisabled;
  const circleTooltip =
    circleState === 'stop' ? (
      stopTooltip
    ) : connectionDisabled ? (
      LOST_CONNECTION_TOOLTIP
    ) : composerAttachmentUploading ? (
      composerUploadTooltip
    ) : circleState === 'queue' ? (
      'Queue message (runs after the current turn)'
    ) : (
      <>
        <div>Send Enter</div>
        <div>New line Shift+Enter</div>
      </>
    );
  // Stop is the inverse solid fill; an empty Send is a quiet filled circle.
  const circleVariant: Pick<ButtonProps, 'color' | 'variant'> = circleDisabled
    ? { color: 'default', variant: 'filled' }
    : circleState === 'stop'
      ? { color: 'default', variant: 'solid' }
      : { color: 'primary', variant: 'solid' };

  const controlSize = isMobile ? MOBILE_TOUCH_TARGET : token.controlHeight;
  const rowButtonStyle: React.CSSProperties = {
    minWidth: controlSize,
    height: controlSize,
    flexShrink: 0,
  };
  const actionTooltip = (fallback: string, reason?: string) =>
    connectionDisabled ? LOST_CONNECTION_TOOLTIP : (reason ?? fallback);
  const pinnedActionButtons: Record<string, React.ReactNode> = {
    upload: (
      <Tooltip
        title={actionTooltip(
          'Attach files',
          composerAttachmentUploading ? composerUploadTooltip : undefined
        )}
      >
        <Button
          type="text"
          aria-label="Attach files"
          icon={<PaperClipOutlined />}
          onClick={onAttachFiles}
          disabled={uploadDisabled}
          style={rowButtonStyle}
          data-testid="upload-bar-btn"
        />
      </Tooltip>
    ),
    'advanced-upload': (
      <Tooltip
        title={actionTooltip(
          'Advanced upload',
          composerAttachmentUploading ? composerUploadTooltip : undefined
        )}
      >
        <Button
          type="text"
          aria-label="Advanced upload"
          icon={<UploadOutlined />}
          onClick={onUploadOpen}
          disabled={advancedUploadDisabled}
          style={rowButtonStyle}
        />
      </Tooltip>
    ),
    fork: (
      <Tooltip
        title={actionTooltip(
          'Fork session',
          composerAttachmentsPresent ? composerAttachmentActionTooltip : undefined
        )}
      >
        <Button
          type="text"
          aria-label="Fork session"
          icon={<ForkOutlined />}
          onClick={onFork}
          disabled={forkDisabled}
          style={rowButtonStyle}
          data-testid="fork-bar-btn"
        />
      </Tooltip>
    ),
    'btw-fork': (
      <Tooltip
        title={actionTooltip(
          'BTW fork',
          composerAttachmentsPresent ? composerAttachmentActionTooltip : undefined
        )}
      >
        <Button
          type="text"
          aria-label="BTW fork"
          icon={<QuestionCircleOutlined />}
          onClick={onBtwSend}
          disabled={btwForkDisabled}
          style={rowButtonStyle}
          data-testid="btw-fork-bar-btn"
        />
      </Tooltip>
    ),
    spawn: (
      <Tooltip
        title={actionTooltip(
          'Spawn subsession',
          composerAttachmentsPresent
            ? composerAttachmentActionTooltip
            : isRunning
              ? 'Not while the session is running'
              : undefined
        )}
      >
        <Button
          type="text"
          aria-label="Spawn subsession"
          icon={<BranchesOutlined />}
          onClick={onSpawnOpen}
          disabled={spawnDisabled}
          style={rowButtonStyle}
        />
      </Tooltip>
    ),
  };

  const effortName = supportsLiveEffort
    ? EFFORT_OPTIONS.find(
        (option) => option.value === (effortLevel ?? toolCaps?.defaultReasoningEffort)
      )?.label
    : undefined;
  const modelChipName = effectiveModel ? getModelChipLabel(modelLabel ?? effectiveModel) : 'Model';
  const modelChipLabel = effortName && !narrow ? `${modelChipName} · ${effortName}` : modelChipName;
  const modelChipAriaLabel = `Model ${modelChipName}${effortName ? `, ${effortName} effort` : ''}. Change`;
  const permissionMeta = getPermissionModeMeta(session.agentic_tool, permissionMode);
  const showPermissionChip = isPermissionNonDefault(session.agentic_tool, permissionMode, {
    sandboxMode: codexSandboxMode,
    approvalPolicy: codexApprovalPolicy,
  });
  const permissionChipName =
    session.agentic_tool === 'codex'
      ? `${codexSandboxMode}, ${codexApprovalPolicy}`
      : getPermissionModeLabel(session.agentic_tool, permissionMode);
  const permissionChipLabel =
    session.agentic_tool === 'codex'
      ? codexApprovalPolicy
      : (permissionMeta?.shortLabel ?? permissionChipName);
  const modelChipTextRef = React.useRef<HTMLSpanElement>(null);
  const permissionChipTextRef = React.useRef<HTMLSpanElement>(null);
  // Card widths at which each folded pin fits again.
  const unfoldWidthsRef = React.useRef<number[]>([]);
  const pinSignature = pinnedItems.join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure the full row when its items change
  React.useLayoutEffect(
    () => setCrowdFold(0),
    [pinSignature, modelChipLabel, permissionChipLabel, circleState]
  );
  React.useLayoutEffect(() => {
    if (!(narrow || isMobile) || !(showPermissionChip || circleState === 'queue')) {
      if (crowdFold) setCrowdFold(0);
      return;
    }
    if (crowdFold > 0 && cardWidth >= unfoldWidthsRef.current[crowdFold - 1]) {
      setCrowdFold(crowdFold - 1);
      return;
    }
    // The chips clip their text rather than overflow. The row is full when the permission chip
    // is clipped, or the model chip can't show its first few words.
    const missing = (text: HTMLElement | null, readable = Number.POSITIVE_INFINITY) =>
      text ? Math.max(0, Math.min(text.scrollWidth, readable) - text.clientWidth) : 0;
    const clipped =
      missing(modelChipTextRef.current, token.fontSizeSM * 6) +
      missing(permissionChipTextRef.current);
    if (clipped > 0 && rowPins.length > 0) {
      unfoldWidthsRef.current[crowdFold] = cardWidth + clipped;
      setCrowdFold(crowdFold + 1);
    }
  });
  const chipStyle: React.CSSProperties = {
    height: controlSize,
    minWidth: 0,
    flexShrink: 1,
    paddingInline: token.paddingXS,
    fontSize: token.fontSizeSM,
  };

  const [openMenu, setOpenMenu] = React.useState<ComposerMenuId | null>(null);
  const [plusPage, setPlusPage] = React.useState<'main' | 'details' | 'mcp'>('main');
  const [modelPage, setModelPage] = React.useState<'model' | 'permissions' | 'advanced'>('model');
  const runAction = (action: () => void) => () => {
    setOpenMenu(null);
    action();
  };
  const [detailsPage, setDetailsPage] = React.useState<'main' | 'mcp'>('main');
  // One breakdown open at a time; opening from an info item expands that item's row.
  const [detailsExpanded, setDetailsExpanded] = React.useState<ExpandableRow | null>(null);
  const toggleExpanded = (row: ExpandableRow) =>
    setDetailsExpanded((current) => (current === row ? null : row));
  const detailsOpen = openMenu === 'details';
  // Which info-line segment Session details is anchored to, and the row it opens on.
  const [detailsAnchor, setDetailsAnchor] = React.useState<string>('more');
  const [detailsFocus, setDetailsFocus] = React.useState<DetailRow | null>(null);
  const {
    usage,
    loading: usageLoading,
    error: usageError,
    retry: refreshUsage,
  } = useSessionUsage(
    client,
    session.session_id,
    detailsOpen || (openMenu === 'plus' && plusPage === 'details'),
    currentUserId
  );
  // #2808: usage is fetched only when disclosed. Keep the last snapshot for the info line.
  const [knownUsage, setKnownUsage] = React.useState<{ sessionId: string; total: number } | null>(
    null
  );
  React.useEffect(() => {
    if (usage) setKnownUsage({ sessionId: session.session_id, total: usage.total });
  }, [usage, session.session_id]);
  const knownUsageTotal =
    knownUsage?.sessionId === session.session_id ? knownUsage.total : undefined;
  const mcpSummary = summarizeSessionMcpServers(
    sessionMcpServerIds,
    mcpServerById,
    userAuthenticatedMcpServerIds
  );
  const contextSnapshot = (
    latestContextWindow?.taskMetadata as
      | { normalized_sdk_response?: { contextUsageSnapshot?: ContextUsageSnapshot } }
      | undefined
  )?.normalized_sdk_response?.contextUsageSnapshot;
  const contextLimit = contextSnapshot?.maxTokens ?? latestContextWindow?.limit ?? 0;
  const contextPercent =
    latestContextWindow && contextLimit > 0
      ? Math.round(
          resolveContextWindowPercentage(
            contextSnapshot?.totalTokens ?? latestContextWindow.used,
            contextLimit,
            contextSnapshot
          )
        )
      : null;
  const contextColor =
    contextPercent === null
      ? token.colorTextTertiary
      : getContextWindowColor(contextPercent, {
          normal: token.colorPrimary,
          warning: token.colorWarning,
          critical: token.colorError,
        });
  const signInWarning =
    unauthedMcpServers.length === 1
      ? `${unauthedMcpServers[0].display_name || unauthedMcpServers[0].name} needs sign-in`
      : unauthedMcpServers.length > 1
        ? `${unauthedMcpServers.length} MCP servers need sign-in`
        : null;
  const mcpWarning = sessionMcpLoadFailed ? "MCP tools didn't load" : signInWarning;
  const usageValue = usage ? `${formatTokenCount(usage.total)} tokens` : usageLoading ? '…' : '';

  const infoPin = (id: string, name: string) => {
    const pinned = pinnedChips.includes(id);
    return (
      <ComposerPinToggle
        pinned={pinned}
        label={`${pinned ? 'Hide' : 'Show'} ${name}`}
        tooltip={pinned ? 'Hide from info bar' : 'Show in info bar'}
        onToggle={() => toggleChip(id)}
      />
    );
  };
  const copyId = (id: string, what: string) => async () => {
    await copyToClipboard(id);
    showSuccess(`${what} copied`);
  };
  const detailRow = (key: DetailRow, children: React.ReactNode) => (
    <div
      data-detail-row={key}
      style={
        detailsOpen && detailsFocus === key
          ? { background: token.colorPrimaryBg, borderRadius: token.borderRadius }
          : undefined
      }
    >
      {children}
    </div>
  );
  const detailBlockStyle: React.CSSProperties = {
    padding: `0 ${token.paddingSM}px ${token.paddingXS}px`,
    fontSize: token.fontSizeSM,
  };
  const timerDetails = footerTimerTask && elapsed.hasTiming && (
    <div style={detailBlockStyle}>
      <TimerDetails
        status={footerTimerTask.status}
        startedAt={footerTimerTask.message_range?.start_timestamp || footerTimerTask.created_at}
        endedAt={footerTimerTask.message_range?.end_timestamp || footerTimerTask.completed_at}
        durationMs={footerTimerTask.duration_ms}
        lastExecutorHeartbeatAt={footerTimerTask.last_executor_heartbeat_at}
        latestExecutorPulse={footerTimerTask.latest_executor_pulse}
      />
    </div>
  );
  const detailsMain = (
    <>
      {!isMobile && <ComposerMenuSection>Session details</ComposerMenuSection>}
      <ComposerMenuNote>Choose what shows above the composer</ComposerMenuNote>
      {detailRow(
        'timer',
        <>
          <ComposerMenuRow
            label="Timer"
            icon={<ClockCircleOutlined />}
            value={
              !elapsed.hasTiming
                ? 'Not started'
                : showStop
                  ? `Running ${elapsed.label}`
                  : elapsed.label
            }
            expanded={timerDetails ? detailsExpanded === 'timer' : undefined}
            onClick={timerDetails ? () => toggleExpanded('timer') : undefined}
            trailing={infoPin('timer', 'timer')}
          />
          {detailsExpanded === 'timer' && timerDetails}
        </>
      )}
      {detailRow(
        'tools',
        <ComposerMenuRow
          label="MCP tools"
          icon={<ApiOutlined />}
          value={String(mcpSummary.attachedCount)}
          drill
          onClick={() => setDetailsPage('mcp')}
          trailing={infoPin('tools', 'MCP tools')}
        />
      )}
      {sessionMcpLoadFailed && (
        <Flex
          align="center"
          gap={token.marginXS}
          style={{ paddingInline: token.paddingSM, paddingBottom: token.paddingXXS }}
        >
          <Typography.Text
            style={{ flex: 1, fontSize: token.fontSizeSM, color: token.colorWarningText }}
          >
            MCP tools didn't load.
          </Typography.Text>
          {onSessionMcpRetry && (
            <Button size="small" onClick={onSessionMcpRetry}>
              Retry
            </Button>
          )}
        </Flex>
      )}
      {unauthedMcpServers.map((server) => (
        <Flex
          key={server.mcp_server_id}
          align="center"
          gap={token.marginXS}
          style={{ paddingInline: token.paddingSM, paddingBottom: token.paddingXXS }}
        >
          <Typography.Text
            style={{ flex: 1, fontSize: token.fontSizeSM, color: token.colorWarningText }}
          >
            {`${server.display_name || server.name} needs sign-in. Its tools are off until you connect.`}
          </Typography.Text>
          <Button size="small" onClick={() => setDetailsPage('mcp')}>
            Connect
          </Button>
        </Flex>
      ))}
      {detailRow(
        'usage',
        <>
          <ComposerMenuRow
            label="Usage"
            icon={<NumberOutlined />}
            value={usageValue}
            expanded={usage || usageError ? detailsExpanded === 'usage' : undefined}
            onClick={usage || usageError ? () => toggleExpanded('usage') : undefined}
            trailing={infoPin('tokens', 'usage')}
          />
          {detailsExpanded === 'usage' && (
            <div style={detailBlockStyle}>
              {usage ? (
                <SessionUsageSummary usage={usage} onRefresh={refreshUsage} />
              ) : (
                <Flex align="center" gap={token.marginXS}>
                  <Typography.Text type="secondary" style={{ flex: 1, fontSize: 'inherit' }}>
                    {usageError}
                  </Typography.Text>
                  <Button type="text" size="small" onClick={refreshUsage}>
                    Refresh
                  </Button>
                </Flex>
              )}
            </div>
          )}
        </>
      )}
      {detailRow(
        'context',
        <>
          <ComposerMenuRow
            label="Context"
            icon={<PieChartOutlined />}
            value={
              contextPercent === null
                ? 'Unknown'
                : `${contextPercent}% of ${formatTokenCount(contextLimit)}`
            }
            expanded={contextPercent !== null ? detailsExpanded === 'context' : undefined}
            onClick={contextPercent !== null ? () => toggleExpanded('context') : undefined}
            trailing={infoPin('context', 'context')}
          />
          {detailsExpanded === 'context' && latestContextWindow && contextPercent !== null && (
            <div style={detailBlockStyle}>
              <Progress
                percent={contextPercent}
                showInfo={false}
                size="small"
                strokeColor={contextColor}
                aria-label={`Context ${contextPercent}% used`}
              />
              <ContextWindowPopoverContent
                used={contextSnapshot?.totalTokens ?? latestContextWindow.used}
                limit={contextLimit}
                percentage={contextPercent}
                taskMetadata={
                  latestContextWindow.taskMetadata as React.ComponentProps<
                    typeof ContextWindowPopoverContent
                  >['taskMetadata']
                }
                onEscape={() => setDetailsExpanded(null)}
                width="100%"
              />
            </div>
          )}
        </>
      )}
      {detailRow(
        'session-ids',
        <ComposerMenuRow
          label="Session IDs"
          icon={<IdcardOutlined />}
          trailing={infoPin('session-ids', 'session IDs')}
        />
      )}
      <ComposerMenuRow
        label="Copy session ID"
        value={shortId(session.session_id)}
        ariaLabel={`Copy session ID ${session.session_id}`}
        icon={<CopyOutlined />}
        onClick={copyId(session.session_id, 'Session ID')}
      />
      {session.sdk_session_id && (
        <ComposerMenuRow
          label="Copy agent session ID"
          value={shortId(session.sdk_session_id)}
          ariaLabel={`Copy agent session ID ${session.sdk_session_id}`}
          icon={<CopyOutlined />}
          onClick={copyId(session.sdk_session_id, 'Agent session ID')}
        />
      )}
      <ComposerMenuNote>
        Pin an item to show it above the composer. MCP sign-in problems always show.
      </ComposerMenuNote>
    </>
  );
  // The attach and manage panel the footer MCP chip opened on main (attach, sign-in, retry).
  const mcpPanel = (
    <div style={{ padding: `${token.paddingXXS}px ${token.paddingSM}px ${token.paddingXS}px` }}>
      <SessionMcpFooterControl
        inline
        client={client}
        currentUserId={currentUserId}
        sessionId={session.session_id}
        sessionMcpServerIds={sessionMcpServerIds}
        sessionMcpLoadFailed={sessionMcpLoadFailed}
        onSessionMcpRetry={onSessionMcpRetry}
        mcpServerById={mcpServerById}
        userAuthenticatedMcpServerIds={userAuthenticatedMcpServerIds}
      />
    </div>
  );
  const detailsContent =
    detailsPage === 'mcp' ? (
      <>
        <ComposerMenuBack label="Session details" onBack={() => setDetailsPage('main')} />
        {mcpPanel}
      </>
    ) : (
      detailsMain
    );
  const openDetailsAt = (segment: InfoSegment) => {
    setDetailsPage('main');
    setDetailsExpanded(isExpandableRow(segment.row) ? segment.row : null);
    setDetailsAnchor(segment.key);
    setDetailsFocus(segment.row);
    setOpenMenu('details');
  };
  const infoSegments: InfoSegment[] = [];
  if (contextPercent !== null && pinnedChips.includes('context')) {
    infoSegments.push({
      key: 'context',
      row: 'context',
      label: (
        <Flex align="center" gap={token.marginXXS}>
          <Progress
            type="circle"
            size={token.fontSizeSM}
            percent={contextPercent}
            showInfo={false}
            strokeWidth={16}
            strokeColor={contextColor}
            aria-hidden
          />
          {contextPercent}%
        </Flex>
      ),
      ariaLabel: `Context ${contextPercent}% used. Session details`,
      tooltip: `Context ${contextPercent}% used`,
    });
  }
  // While a turn runs, the working line carries the live time.
  if (pinnedChips.includes('timer') && elapsed.hasTiming && !showStop) {
    infoSegments.push({
      key: 'timer',
      row: 'timer',
      label: elapsed.label,
      ariaLabel: `Turn time ${elapsed.label}. Session details`,
      tooltip: 'Turn time',
    });
  }
  if (pinnedChips.includes('tools') && mcpSummary.attachedCount > 0) {
    infoSegments.push({
      key: 'tools',
      row: 'tools',
      label: `MCP ${mcpSummary.attachedCount}`,
      ariaLabel: `MCP tools, ${mcpSummary.attachedCount}. Session details`,
      tooltip: 'MCP tools',
    });
  }
  if (pinnedChips.includes('tokens') && knownUsageTotal !== undefined) {
    const tokens = `${formatTokenCount(knownUsageTotal)} tokens`;
    infoSegments.push({
      key: 'tokens',
      row: 'usage',
      label: tokens,
      ariaLabel: `Usage, ${tokens}. Session details`,
      tooltip: 'Usage',
    });
  }
  if (pinnedChips.includes('session-ids')) {
    const id = shortId(session.session_id);
    infoSegments.push({
      key: 'session-ids',
      row: 'session-ids',
      label: id,
      ariaLabel: `Session ID ${id}. Session details`,
      tooltip: 'Session ID',
    });
  }
  // MCP problems always show on the info line, even while typing.
  if (mcpWarning) {
    infoSegments.push({
      key: 'mcp-warning',
      row: 'tools',
      label: mcpWarning,
      ariaLabel: `${mcpWarning}. Session details`,
      tooltip: 'MCP tools',
      warning: true,
    });
  }
  // An open Session details keeps its anchor, even if the line's content changes underneath it.
  const lastSegmentsRef = React.useRef(new Map<string, InfoSegment>());
  for (const segment of infoSegments) lastSegmentsRef.current.set(segment.key, segment);
  const anchored = detailsOpen ? lastSegmentsRef.current.get(detailsAnchor) : undefined;
  if (anchored && !infoSegments.some((segment) => segment.key === anchored.key)) {
    infoSegments.push(anchored);
  }
  const moreSegment: InfoSegment = {
    key: 'more',
    row: null,
    label: '›',
    ariaLabel: 'Session details',
    tooltip: (
      <>
        <div>Session details</div>
        <div>Click to see details and choose what shows here</div>
      </>
    ),
  };
  const infoButtonStyle: React.CSSProperties = {
    height: isMobile ? MOBILE_TOUCH_TARGET : token.controlHeightSM,
    minWidth: isMobile ? MOBILE_TOUCH_TARGET : undefined,
    paddingInline: token.paddingXXS,
    gap: token.sizeXXS,
    fontSize: token.fontSizeSM,
    flexShrink: 0,
  };
  const renderSegment = (segment: InfoSegment) => {
    const open = detailsOpen && detailsAnchor === segment.key;
    return (
      <ComposerMenu
        key={segment.key}
        above={cardRef}
        sheet={isMobile}
        title={segment.key === 'mcp-warning' ? 'MCP tools' : 'Session details'}
        open={open}
        onOpenChange={(next) => (next ? openDetailsAt(segment) : setOpenMenu(null))}
        content={segment.key === 'mcp-warning' ? mcpPanel : detailsContent}
        focusTarget={
          segment.row && segment.key !== 'mcp-warning'
            ? `[data-detail-row="${segment.row}"]`
            : undefined
        }
      >
        <Tooltip title={segment.tooltip} open={open ? false : undefined}>
          <Button
            type="text"
            size="small"
            aria-label={segment.ariaLabel}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={isMobile ? () => openDetailsAt(segment) : undefined}
            style={{
              ...infoButtonStyle,
              color: segment.warning ? token.colorWarningText : token.colorTextTertiary,
            }}
            data-testid={`info-segment-${segment.key}`}
          >
            {segment.label}
          </Button>
        </Tooltip>
      </ComposerMenu>
    );
  };
  // Phones hide the info while typing unless an MCP problem needs attention.
  const infoVisible = detailsOpen || !(keyboardUp && !mcpWarning);
  // One line only: when the segments don't fit, keep the %, any MCP problem and "›".
  const [foldInfo, setFoldInfo] = React.useState(false);
  const statusRowRef = React.useRef<HTMLDivElement>(null);
  const statusRef = React.useRef<HTMLDivElement>(null);
  const infoGroupRef = React.useRef<HTMLDivElement>(null);
  const fullInfoWidthRef = React.useRef(0);
  const segmentKeys = infoSegments.map((segment) => segment.key).join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure the full set when items change
  React.useLayoutEffect(() => setFoldInfo(false), [segmentKeys]);
  const measureInfo = React.useCallback(() => {
    const row = statusRowRef.current;
    const group = infoGroupRef.current;
    if (!row || !group || row.clientWidth === 0) return;
    const available =
      row.clientWidth -
      (statusRef.current?.offsetWidth ?? 0) -
      token.paddingXS * 2 -
      (statusRef.current ? token.marginXS : 0);
    setFoldInfo((folded) => {
      if (!folded) {
        fullInfoWidthRef.current = group.scrollWidth;
        return group.scrollWidth > available + 1;
      }
      return fullInfoWidthRef.current > available + 1;
    });
  }, [token.paddingXS, token.marginXS]);
  React.useLayoutEffect(() => measureInfo());
  React.useLayoutEffect(() => {
    const row = statusRowRef.current;
    if (!row) return;
    const observer = new ResizeObserver(() => measureInfo());
    observer.observe(row);
    return () => observer.disconnect();
  }, [measureInfo]);
  const shownSegments = foldInfo
    ? infoSegments.filter(
        (segment) =>
          segment.key === 'context' ||
          segment.key === 'mcp-warning' ||
          (detailsOpen && segment.key === detailsAnchor)
      )
    : infoSegments;
  const infoGroup = infoVisible && (
    <Flex
      ref={infoGroupRef}
      align="center"
      style={{ minWidth: 0, marginInlineStart: 'auto', overflow: 'hidden' }}
      data-testid="composer-info-line"
      data-folded={foldInfo || undefined}
    >
      {shownSegments.map((segment, index) => (
        <React.Fragment key={segment.key}>
          {index > 0 && (
            <span
              aria-hidden
              data-testid="info-separator"
              style={{ color: token.colorTextQuaternary, fontSize: token.fontSizeSM }}
            >
              ·
            </span>
          )}
          {renderSegment(segment)}
        </React.Fragment>
      ))}
      {renderSegment(moreSegment)}
    </Flex>
  );

  const attachmentsHint = composerAttachmentsPresent ? composerAttachmentActionTooltip : undefined;
  const actionRows: Record<
    string,
    { label: string; hint: string; icon: React.ReactNode; onClick: () => void; disabled: boolean }
  > = {
    upload: {
      label: 'Attach files',
      hint: 'Photos, screenshots and files',
      icon: <PaperClipOutlined />,
      onClick: onAttachFiles,
      disabled: uploadDisabled,
    },
    'advanced-upload': {
      label: 'Advanced upload',
      hint: 'Choose where files go',
      icon: <UploadOutlined />,
      onClick: onUploadOpen,
      disabled: advancedUploadDisabled,
    },
    fork: {
      label: 'Fork session',
      hint: attachmentsHint ?? 'Copy this session and branch off',
      icon: <ForkOutlined />,
      onClick: onFork,
      disabled: forkDisabled,
    },
    'btw-fork': {
      label: 'BTW fork',
      hint: attachmentsHint ?? 'Ask a side question in a throwaway fork',
      icon: <QuestionCircleOutlined />,
      onClick: onBtwSend,
      disabled: btwForkDisabled,
    },
    spawn: {
      label: 'Spawn subsession',
      hint:
        attachmentsHint ??
        (isRunning ? 'Not while the session is running' : 'Start a child session for a subtask'),
      icon: <BranchesOutlined />,
      onClick: onSpawnOpen,
      disabled: spawnDisabled,
    },
    mcp: {
      label: 'MCP tools',
      hint: mcpWarning ?? 'Attach servers and sign in',
      icon: <ApiOutlined />,
      onClick: () => setPlusPage('mcp'),
      disabled: false,
    },
  };

  const pinsFull = isMobile && pinnedItems.length >= COMPACT_PIN_LIMIT;
  const renderActionRow = (id: string) => {
    const row = actionRows[id];
    const pinned = pinnedItems.includes(id);
    const isMcp = id === 'mcp';
    return (
      <ComposerMenuRow
        key={id}
        label={row.label}
        hint={connectionDisabled ? LOST_CONNECTION_TOOLTIP : row.hint}
        icon={row.icon}
        disabled={row.disabled}
        // MCP tools drills into its panel inside this menu; the others run and close it.
        onClick={isMcp ? () => setPlusPage('mcp') : runAction(row.onClick)}
        value={isMcp ? String(mcpSummary.attachedCount) : undefined}
        drill={isMcp}
        trailing={
          <ComposerPinToggle
            pinned={pinned}
            label={
              pinned ? `Unpin ${row.label} from the composer` : `Pin ${row.label} to the composer`
            }
            tooltip={pinned ? 'Unpin from the composer' : 'Pin to the composer'}
            disabled={!pinned && pinsFull}
            onToggle={() => togglePin(id)}
          />
        }
      />
    );
  };
  const plusMenuContent = (
    <>
      <ComposerMenuSection>Add to message</ComposerMenuSection>
      {['upload', 'advanced-upload']
        .filter((id) => availableActions.includes(id))
        .map(renderActionRow)}
      <ComposerMenuSection>Session</ComposerMenuSection>
      {['fork', 'btw-fork', 'spawn']
        .filter((id) => availableActions.includes(id))
        .map(renderActionRow)}
      <ComposerMenuSection>Tools</ComposerMenuSection>
      {renderActionRow('mcp')}
      <ComposerMenuNote>
        {pinsFull
          ? 'The composer fits 2 pins on a phone. Unpin one to add another.'
          : 'Pin an action to keep it in the composer row.'}
      </ComposerMenuNote>
      {foldedPins.map((id) => (
        <ComposerMenuNote key={id}>
          {`${actionRows[id].label} stays in here until the panel is wider.`}
        </ComposerMenuNote>
      ))}
      <Divider style={{ margin: `${token.marginXXS}px 0` }} />
      <ComposerMenuRow
        label="Session details"
        icon={<InfoCircleOutlined />}
        drill
        onClick={() => {
          setDetailsPage('main');
          setDetailsExpanded(null);
          setPlusPage('details');
        }}
      />
      {onOpenSessionSettings && (
        <ComposerMenuRow
          label="Session settings"
          icon={<SettingOutlined />}
          onClick={runAction(() => onOpenSessionSettings(session.session_id))}
        />
      )}
    </>
  );

  const plusButton = (
    <ComposerMenu
      above={cardRef}
      sheet={isMobile}
      title="Add files and actions"
      open={openMenu === 'plus'}
      onOpenChange={(open) => {
        setPlusPage('main');
        setOpenMenu(open ? 'plus' : null);
      }}
      content={
        plusPage === 'mcp' ? (
          <>
            <ComposerMenuBack label="Add files and actions" onBack={() => setPlusPage('main')} />
            {mcpPanel}
          </>
        ) : plusPage === 'details' ? (
          <>
            {detailsPage === 'main' && (
              <ComposerMenuBack label="Add files and actions" onBack={() => setPlusPage('main')} />
            )}
            {detailsContent}
          </>
        ) : (
          plusMenuContent
        )
      }
    >
      <Tooltip title="Add files and actions" open={openMenu === 'plus' ? false : undefined}>
        <Button
          type="text"
          aria-label="Add files and actions"
          aria-haspopup="dialog"
          aria-expanded={openMenu === 'plus'}
          icon={<PlusOutlined />}
          onClick={
            isMobile
              ? () => {
                  setPlusPage('main');
                  setOpenMenu('plus');
                }
              : undefined
          }
          style={rowButtonStyle}
        />
      </Tooltip>
    </ComposerMenu>
  );

  const effortLevels = toolCaps?.reasoningEffortLevels ?? [];
  const isClaudeSession = session.agentic_tool === 'claude-code';
  const permissionModes = getPermissionModes(session.agentic_tool);
  const defaultPermissionMode = getDefaultPermissionMode(session.agentic_tool);
  const presetNote = managedByPreset ? (
    <ComposerMenuNote>Managed by preset. Switch presets in session settings.</ComposerMenuNote>
  ) : null;
  const defaultTag = <span style={{ fontSize: token.fontSizeSM }}>default</span>;
  const permissionRadioRows = (
    title: string,
    rows: { value: string; label: string; description?: string; isDefault?: boolean }[],
    current: string,
    onSelect: (value: string) => void
  ) => (
    <div role="radiogroup" aria-label={title}>
      <ComposerMenuSection>{title}</ComposerMenuSection>
      {rows.map((row) => (
        <ComposerMenuRow
          key={row.value}
          label={row.label}
          hint={row.description}
          checked={row.value === current}
          value={row.isDefault ? defaultTag : undefined}
          disabled={managedByPreset}
          onClick={() => onSelect(row.value)}
        />
      ))}
    </div>
  );
  const codexDefaults = mapToCodexPermissionConfig(defaultPermissionMode);
  const permissionsPage = (
    <>
      <ComposerMenuBack label="Model" onBack={() => setModelPage('model')} />
      {presetNote}
      {session.agentic_tool === 'gemini' && isGeminiManualMode(permissionMode) && (
        <ComposerMenuNote>
          {GEMINI_MANUAL_MESSAGE} If your settings are managed, ask a workspace admin to update the
          preset.
        </ComposerMenuNote>
      )}
      {session.agentic_tool === 'codex' ? (
        <>
          {permissionRadioRows(
            'Sandbox',
            CODEX_SANDBOX_MODES.map((mode) => ({
              ...mode,
              isDefault: mode.value === codexDefaults.sandboxMode,
            })),
            codexSandboxMode,
            (value) => onCodexPermissionChange(value as CodexSandboxMode, codexApprovalPolicy)
          )}
          {permissionRadioRows(
            'Approval',
            CODEX_APPROVAL_POLICIES.map((policy) => ({
              ...policy,
              isDefault: policy.value === codexDefaults.approvalPolicy,
            })),
            codexApprovalPolicy,
            (value) => onCodexPermissionChange(codexSandboxMode, value as CodexApprovalPolicy)
          )}
        </>
      ) : (
        permissionRadioRows(
          'Permissions',
          permissionModes.map((mode) => ({
            value: mode.mode,
            label: mode.label,
            description: mode.description,
            isDefault: mode.mode === defaultPermissionMode,
          })),
          permissionMode,
          (value) => onPermissionModeChange(value as PermissionMode)
        )
      )}
    </>
  );
  // The rows check the same model the chip names, even before the session stores one.
  const modelRowsValue: ModelConfig | undefined =
    modelConfig ?? (effectiveModel ? { mode: 'alias', model: effectiveModel } : undefined);
  const modelPageContent = (
    <>
      {presetNote}
      <ModelSelector
        key={session.session_id}
        value={modelRowsValue}
        onCommit={onModelConfigCommit}
        agentic_tool={session.agentic_tool}
        client={client}
        branchId={session.branch_id}
        catalogEnabled={session.created_by === currentUserId}
        compact
        showAdvisor={false}
        renderRows={({ options, currentModel, select }) => (
          <div
            role="radiogroup"
            aria-label="Model"
            style={{ maxHeight: 'min(320px, 40dvh)', overflowY: 'auto' }}
          >
            <ComposerMenuSection>Model</ComposerMenuSection>
            {options.map((option) => (
              <ComposerMenuRow
                key={option.value}
                label={option.label}
                hint={option.description}
                checked={option.value === currentModel}
                value={option.isDefault ? defaultTag : undefined}
                disabled={managedByPreset}
                onClick={() => select(option.value)}
              />
            ))}
          </div>
        )}
      />
      {effortLevels.length > 0 && (
        <>
          <ComposerMenuSection>Effort</ComposerMenuSection>
          <div style={{ paddingInline: token.paddingXS, paddingBottom: token.paddingXXS }}>
            <Segmented
              block
              aria-label="Effort"
              size={isMobile ? 'large' : 'middle'}
              disabled={managedByPreset}
              value={effortLevel ?? toolCaps?.defaultReasoningEffort}
              onChange={(value) => onEffortChange(value as EffortLevel)}
              styles={{ label: { paddingInline: token.paddingXXS, fontSize: token.fontSizeSM } }}
              options={EFFORT_OPTIONS.filter((option) => effortLevels.includes(option.value)).map(
                (option) => ({
                  value: option.value,
                  label: option.label,
                  title: option.description,
                })
              )}
            />
          </div>
        </>
      )}
      <Divider style={{ margin: `${token.marginXXS}px 0` }} />
      <ComposerMenuRow
        label="Permissions"
        icon={<LockOutlined />}
        value={permissionChipName}
        drill
        onClick={() => setModelPage('permissions')}
      />
      <ComposerMenuRow
        label={isClaudeSession ? 'Advisor and exact version' : 'Exact version'}
        icon={<ExperimentOutlined />}
        hint={modelConfig?.advisorModel ? `Advisor: ${modelConfig.advisorModel}` : undefined}
        disabled={managedByPreset}
        drill
        onClick={() => setModelPage('advanced')}
      />
      {onOpenSessionSettings && (
        <ComposerMenuRow
          label="Session settings"
          icon={<SettingOutlined />}
          onClick={runAction(() => onOpenSessionSettings(session.session_id))}
        />
      )}
    </>
  );
  // Main's model chip popover held the full picker: advisor model and "Pin a specific version".
  const advancedModelPage = (
    <>
      <ComposerMenuBack label="Model" onBack={() => setModelPage('model')} />
      <div style={{ padding: `0 ${token.paddingSM}px ${token.paddingSM}px` }}>
        <ModelSelector
          key={`${session.session_id}:advanced`}
          value={modelRowsValue}
          onCommit={onModelConfigCommit}
          agentic_tool={session.agentic_tool}
          client={client}
          branchId={session.branch_id}
          catalogEnabled={session.created_by === currentUserId}
        />
      </div>
    </>
  );
  const modelMenuContent =
    modelPage === 'permissions'
      ? permissionsPage
      : modelPage === 'advanced'
        ? advancedModelPage
        : modelPageContent;
  const openModelMenu = (menu: 'model' | 'permissions') => (open: boolean) => {
    setModelPage(menu === 'permissions' ? 'permissions' : 'model');
    setOpenMenu(open ? menu : null);
  };

  const modelChip = (
    <ComposerMenu
      above={cardRef}
      sheet={isMobile}
      title="Model"
      open={openMenu === 'model'}
      onOpenChange={openModelMenu('model')}
      content={modelMenuContent}
    >
      <Tooltip title="Model and effort" open={openMenu === 'model' ? false : undefined}>
        <Button
          type="text"
          aria-label={modelChipAriaLabel}
          aria-haspopup="dialog"
          aria-expanded={openMenu === 'model'}
          onClick={isMobile ? () => openModelMenu('model')(true) : undefined}
          style={{ ...chipStyle, ...(openMenu === 'model' && { color: token.colorText }) }}
          data-testid="model-chip"
        >
          <Typography.Text
            ref={modelChipTextRef}
            ellipsis
            style={{ minWidth: 0, fontSize: 'inherit', color: 'inherit' }}
          >
            {modelChipLabel}
          </Typography.Text>
        </Button>
      </Tooltip>
    </ComposerMenu>
  );

  const permissionChip = showPermissionChip && (
    <ComposerMenu
      above={cardRef}
      sheet={isMobile}
      title="Permissions"
      open={openMenu === 'permissions'}
      onOpenChange={openModelMenu('permissions')}
      content={modelMenuContent}
    >
      <Tooltip title="Permissions" open={openMenu === 'permissions' ? false : undefined}>
        <Button
          type="text"
          aria-label={`Permissions: ${permissionChipName}. Change`}
          aria-haspopup="dialog"
          aria-expanded={openMenu === 'permissions'}
          onClick={isMobile ? () => openModelMenu('permissions')(true) : undefined}
          // The permission label is short and always shown in full; the model chip gives way.
          style={{
            ...chipStyle,
            flexShrink: 0,
            ...(openMenu === 'permissions' && { color: token.colorText }),
          }}
          data-testid="permission-chip"
        >
          <Typography.Text
            ref={permissionChipTextRef}
            ellipsis
            style={{ minWidth: 0, fontSize: 'inherit', color: 'inherit' }}
          >
            {permissionChipLabel}
          </Typography.Text>
        </Button>
      </Tooltip>
    </ComposerMenu>
  );

  const workingLine = showStop && (
    <Flex
      ref={statusRef}
      align="center"
      gap={token.marginXS}
      style={{ flexShrink: 0, fontSize: token.fontSizeSM, color: token.colorTextSecondary }}
      data-testid="composer-working-line"
    >
      <span
        aria-hidden
        className={showActivity && !reducedMotion ? 'status-dot-run' : undefined}
        style={{
          width: token.sizeXS,
          height: token.sizeXS,
          borderRadius: '50%',
          background: stopBusy ? token.colorWarning : token.colorPrimary,
          flexShrink: 0,
        }}
      />
      {/* Sized for the longer "Stopping", so Stop stays put when the label changes. */}
      <span
        role="status"
        aria-label={showActivity ? 'Agent is working' : undefined}
        style={{ display: 'inline-grid', fontVariantNumeric: 'tabular-nums' }}
      >
        <span style={{ gridArea: '1 / 1' }} data-testid="composer-working-label">
          {stopBusy ? 'Stopping' : 'Working'} {workingElapsed}
        </span>
        <span aria-hidden style={{ gridArea: '1 / 1', visibility: 'hidden' }}>
          Stopping {workingElapsed}
        </span>
      </span>
      {circleState !== 'stop' && (
        <Tooltip title={stopTooltip}>
          <Button
            type="text"
            size="small"
            aria-label="Stop the agent"
            aria-busy={stopBusy}
            disabled={stopDisabled}
            onClick={onStop}
            style={infoButtonStyle}
          >
            {/* The spinner takes the word's place, so the button keeps its width. */}
            <span style={{ display: 'inline-grid', placeItems: 'center' }}>
              <span style={{ gridArea: '1 / 1', visibility: stopBusy ? 'hidden' : undefined }}>
                Stop
              </span>
              {stopBusy && <LoadingOutlined style={{ gridArea: '1 / 1' }} />}
            </span>
          </Button>
        </Tooltip>
      )}
    </Flex>
  );

  // One quiet row above the card: the running status on the left, pinned info on the right.
  const statusRow = (showStop || infoVisible) && (
    // Stop and the info items share the subtle hover fill, so the row reads as clickable.
    <ConfigProvider theme={{ components: { Button: { textHoverBg: token.colorFillTertiary } } }}>
      <Flex
        ref={statusRowRef}
        align="center"
        gap={token.marginXS}
        style={{
          minWidth: 0,
          minHeight: isMobile ? MOBILE_TOUCH_TARGET : token.controlHeightSM,
          paddingInline: token.paddingXS,
          marginBottom: token.marginXXS,
          whiteSpace: 'nowrap',
        }}
        data-testid="composer-status-row"
      >
        {workingLine}
        {infoGroup}
      </Flex>
    </ConfigProvider>
  );

  const mcpButton = (
    <ComposerMenu
      above={cardRef}
      sheet={isMobile}
      title="MCP tools"
      open={openMenu === 'mcp'}
      onOpenChange={(open) => setOpenMenu(open ? 'mcp' : null)}
      content={mcpPanel}
    >
      <Tooltip title="MCP tools" open={openMenu === 'mcp' ? false : undefined}>
        <Button
          type="text"
          aria-label={`MCP tools, ${mcpSummary.attachedCount} attached`}
          aria-haspopup="dialog"
          aria-expanded={openMenu === 'mcp'}
          icon={<ApiOutlined />}
          onClick={isMobile ? () => setOpenMenu('mcp') : undefined}
          style={{
            ...rowButtonStyle,
            paddingInline: token.paddingXS,
            fontSize: token.fontSizeSM,
            ...(openMenu === 'mcp' && { color: token.colorText }),
            ...(mcpWarning && { color: token.colorWarningText }),
          }}
          data-testid="mcp-bar-btn"
        >
          {mcpSummary.attachedCount > 0 ? mcpSummary.attachedCount : null}
        </Button>
      </Tooltip>
    </ComposerMenu>
  );
  const pinnedRow = rowPins.map((id) => (
    <React.Fragment key={id}>{id === 'mcp' ? mcpButton : pinnedActionButtons[id]}</React.Fragment>
  ));

  return (
    <div
      style={{
        position: 'relative',
        flexShrink: 0,
        // Keep all padding longhand: an undefined paddingBottom would clear
        // the bottom inset supplied by a padding shorthand in React.
        paddingTop: token.paddingXS,
        paddingInline: token.paddingXS,
        paddingBottom: keyboardUp
          ? `calc(${token.paddingXS}px + env(safe-area-inset-bottom))`
          : token.paddingXS,
        marginLeft: -token.sizeUnit * 6,
        marginRight: -token.sizeUnit * 6,
      }}
    >
      <RecoveryActions
        task={recoveryTask}
        busy={stopRequestInFlight}
        disconnected={connectionDisabled}
        canReopen={canReopenSession}
        onRetry={onRetryCleanup}
        onReopen={onStop}
        error={recoveryError}
      />

      {/* Unauthorized MCP servers block their tools silently; nudge above the composer. */}
      {showMcpNotice && (
        <CompactNotice
          type="warning"
          message={mcpNoticeMessage}
          onDismiss={() => setDismissedMcpSignature(unauthedSignature)}
          dismissLabel="Dismiss MCP connection notice"
          data-testid="mcp-disconnected-notice"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          style={{ marginBottom: token.marginXS }}
        />
      )}

      {queueSlot}

      {statusRow}

      <SessionComposerDropZone
        disabled={composerAttachmentUploading}
        onDragActiveChange={onDropActiveChange}
        onFilesDrop={onFilesDrop}
        radius={token.borderRadius * 2}
      >
        <div
          ref={cardRef}
          data-testid="composer-card"
          onFocus={(event) => {
            setCardFocused(true);
            setTextFocused(event.target instanceof HTMLTextAreaElement);
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setCardFocused(false);
              setTextFocused(false);
            }
          }}
          style={{
            ...glassSurfaceStyle(token, 0.7),
            display: 'flex',
            flexDirection: 'column',
            gap: token.sizeXXS,
            borderRadius: token.borderRadius * 2,
            borderWidth: token.lineWidth,
            borderStyle: token.lineType,
            borderColor: cardFocused ? token.colorPrimary : token.colorBorder,
            boxShadow: cardFocused
              ? `0 0 0 ${token.controlOutlineWidth}px ${token.controlOutline}`
              : undefined,
            padding: `${token.paddingXXS + 2}px ${token.paddingXXS + 2}px ${token.paddingXXS + 2}px ${token.paddingSM}px`,
            transition: reducedMotion ? undefined : `border-color ${token.motionDurationFast}`,
          }}
        >
          <Flex vertical gap={token.sizeXS} style={{ minWidth: 0 }}>
            {promptInputSlot}
          </Flex>
          {/* The row reads as secondary to the prompt: 12px, secondary text, full text on hover. */}
          <ConfigProvider
            theme={{
              components: {
                Button: {
                  textTextColor: token.colorTextSecondary,
                  textTextHoverColor: token.colorText,
                  textTextActiveColor: token.colorText,
                },
              },
            }}
          >
            <Flex align="center" gap={token.sizeXXS} style={{ minWidth: 0 }}>
              {plusButton}
              {pinnedRow}
              {modelChip}
              {permissionChip}
              <span style={{ flex: 1 }} />
              {/* The queued count rides on the round button in every state, as on main. */}
              <Badge
                count={queuedCount}
                size="small"
                offset={
                  isMobile ? [-(MOBILE_TOUCH_TARGET - CIRCLE_VISUAL_COMPACT) / 2, 4] : [-2, 2]
                }
                styles={{
                  root: { display: 'inline-flex', flexShrink: 0 },
                  indicator: {
                    fontSize: token.fontSizeSM,
                    height: token.fontSizeSM + 4,
                    minWidth: token.fontSizeSM + 4,
                    lineHeight: `${token.fontSizeSM + 4}px`,
                    background: token.colorTextSecondary,
                    color: token.colorBgContainer,
                    boxShadow: `0 0 0 ${token.lineWidth}px ${token.colorBgContainer}`,
                  },
                }}
                data-testid="composer-queued-badge"
              >
                <Tooltip title={circleTooltip}>
                  <Button
                    {...circleVariant}
                    // Queue is a labelled pill, so it reads differently from Send at a glance.
                    shape={circleState === 'queue' ? 'round' : 'circle'}
                    aria-label={circleLabel}
                    aria-disabled={circleDisabled || undefined}
                    aria-busy={circleState === 'stop' ? stopBusy : undefined}
                    loading={circleState === 'stop' && stopBusy}
                    icon={
                      circleState === 'stop' ? (
                        <span
                          aria-hidden
                          style={{
                            display: 'inline-block',
                            width: token.sizeXS + 2,
                            height: token.sizeXS + 2,
                            borderRadius: token.borderRadiusXS,
                            background: 'currentColor',
                          }}
                        />
                      ) : circleState === 'queue' ? undefined : (
                        <ArrowUpOutlined />
                      )
                    }
                    // Keep the keyboard up on phones and focus in the text after a tap.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={
                      circleDisabled ? undefined : circleState === 'stop' ? onStop : onSendPrompt
                    }
                    style={{
                      width: circleState === 'queue' ? undefined : controlSize,
                      height: controlSize,
                      minWidth: controlSize,
                      flexShrink: 0,
                      boxShadow: 'none',
                      ...(circleState === 'queue' &&
                        !isMobile && { paddingInline: token.paddingSM }),
                      // Phones: a 36px fill inside the 44px target keeps the circle clear of the card edge.
                      ...(isMobile && {
                        border: 'none',
                        padding: (MOBILE_TOUCH_TARGET - CIRCLE_VISUAL_COMPACT) / 2,
                        backgroundClip: 'content-box',
                      }),
                      transition: reducedMotion ? 'none' : undefined,
                      cursor: circleDisabled ? 'not-allowed' : undefined,
                    }}
                    data-testid="composer-circle"
                  >
                    {circleState === 'queue' && (
                      // Phones clip the fill to the content box, so the label carries its own padding.
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: token.marginXXS,
                          paddingInline: isMobile ? token.paddingSM : 0,
                        }}
                      >
                        Queue
                        <ArrowUpOutlined aria-hidden />
                      </span>
                    )}
                  </Button>
                </Tooltip>
              </Badge>
            </Flex>
          </ConfigProvider>
        </div>
      </SessionComposerDropZone>
    </div>
  );
};

export const SessionFooter = React.memo(SessionFooterInner);
SessionFooter.displayName = 'SessionFooter';
