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
} from '@agor-live/client';
import {
  ApiOutlined,
  ArrowUpOutlined,
  BranchesOutlined,
  ClockCircleOutlined,
  CopyOutlined,
  ForkOutlined,
  IdcardOutlined,
  InfoCircleOutlined,
  LockOutlined,
  NumberOutlined,
  PaperClipOutlined,
  PieChartOutlined,
  PlusOutlined,
  QuestionCircleOutlined,
  SettingOutlined,
  UnorderedListOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import type { ButtonProps } from 'antd';
import { Button, Divider, Flex, Progress, Segmented, Tooltip, Typography, theme } from 'antd';
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
  getPermissionModeMeta,
  getPermissionModes,
} from '../PermissionModeSelector';
import { getModelChipLabel } from '../Pill/modelDisplay';
import { useElapsedDuration } from '../Pill/TimerPill';
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
  splitPinnedActions,
} from './composerState';
import { RecoveryActions } from './RecoveryActions';
import { SessionComposerDropZone } from './SessionComposerDropZone';
import { SessionMcpFooterControl } from './SessionMcpFooterControl';

export interface SessionFooterProps {
  // Session data for chips
  session: Session & { agentic_tool: AgenticToolName };
  currentUserId?: string;
  footerTimerTask: Task | null;
  latestContextWindow: { used: number; limit: number; taskMetadata: unknown } | null;
  // MCP data for Tools chip
  sessionMcpServerIds: string[];
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
  /** Files dropped anywhere on the card. */
  onFilesDrop: (files: File[]) => void;
  onDropActiveChange?: (active: boolean) => void;
}

type ComposerMenuId = 'plus' | 'model' | 'permissions' | 'details' | 'details-context';

const formatTokenCount = (count: number) =>
  count >= 1000 ? `${(count / 1000).toFixed(count >= 100_000 ? 0 : 1)}k` : String(count);

const PINNABLE_ACTIONS = ['upload', 'advanced-upload', 'fork', 'btw-fork', 'spawn'];

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
  // On phones the tab bar hides while the composer has focus; the composer then owns the bottom inset.
  const keyboardUp = isMobile && cardFocused;
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
  const { row: rowPins, folded: foldedPins } = splitPinnedActions(
    pinnedItems,
    availableActions,
    isMobile || narrow ? COMPACT_PIN_LIMIT : undefined
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

  // Model name + token counts for individual chips. A brand-new session hasn't
  // persisted its model into model_config yet — it's resolved from tool/user
  // defaults at runtime — so fall back to the tool's default model. Without this
  // the chip wouldn't render (and its click-to-change popover would be
  // unreachable) until the user first changed the model via Session Settings.
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
  // A disconnected install needs a working recovery control even when the
  // user previously unpinned Tools. Reveal the MCP badge for as long as any
  // attached server needs authentication; once recovered, the saved pin
  // preference takes effect again.
  const mcpNoticeMessage =
    unauthedMcpServers.length === 1
      ? `${unauthedMcpServers[0].display_name || unauthedMcpServers[0].name} isn’t connected. Open Session details to connect it.`
      : `${unauthedMcpServers.length} MCP servers aren’t connected. Open Session details to connect them.`;

  const composerAttachmentActionTooltip = 'Attachments are only supported for normal Send for now';
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
  const circleLabel =
    circleState === 'stop' ? 'Stop' : circleState === 'queue' ? 'Queue message' : 'Send';
  const circleDisabled = circleState === 'stop' ? stopDisabled : sendDisabled;
  const circleTooltip =
    circleState === 'stop' ? (
      stopTooltip
    ) : connectionDisabled ? (
      LOST_CONNECTION_TOOLTIP
    ) : composerAttachmentUploading ? (
      composerUploadTooltip
    ) : circleState === 'queue' ? (
      'Queue message Enter'
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
      : (permissionMeta?.label ?? permissionMode);
  const permissionChipLabel =
    session.agentic_tool === 'codex'
      ? codexApprovalPolicy
      : (permissionMeta?.shortLabel ?? permissionChipName);
  const chipStyle: React.CSSProperties = {
    height: controlSize,
    minWidth: 0,
    flexShrink: 1,
    paddingInline: token.paddingXS,
    fontSize: token.fontSize,
  };

  const [openMenu, setOpenMenu] = React.useState<ComposerMenuId | null>(null);
  const [plusPage, setPlusPage] = React.useState<'main' | 'details'>('main');
  const [modelPage, setModelPage] = React.useState<'model' | 'permissions'>('model');
  const runAction = (action: () => void) => () => {
    setOpenMenu(null);
    action();
  };
  const [detailsPage, setDetailsPage] = React.useState<'main' | 'mcp'>('main');
  const detailsOpen = openMenu === 'details' || openMenu === 'details-context';
  const { usage, loading: usageLoading } = useSessionUsage(
    client,
    session.session_id,
    detailsOpen || (openMenu === 'plus' && plusPage === 'details'),
    currentUserId
  );
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
  const usageValue = usage ? `${formatTokenCount(usage.total)} tokens` : usageLoading ? '…' : '';
  const infoItems = [
    pinnedChips.includes('timer') && elapsed.hasTiming ? elapsed.label : null,
    pinnedChips.includes('tools') && mcpSummary.attachedCount > 0
      ? `MCP ${mcpSummary.attachedCount}`
      : null,
    pinnedChips.includes('tokens') ? 'Usage' : null,
    pinnedChips.includes('session-ids') ? session.session_id.slice(0, 8) : null,
  ].filter((item): item is string => Boolean(item));

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
  const detailsMain = (
    <>
      <ComposerMenuRow
        label="Timer"
        icon={<ClockCircleOutlined />}
        value={elapsed.hasTiming ? elapsed.label : 'Not started'}
        trailing={infoPin('timer', 'timer')}
      />
      <ComposerMenuRow
        label="MCP tools"
        icon={<ApiOutlined />}
        value={String(mcpSummary.attachedCount)}
        drill
        onClick={() => setDetailsPage('mcp')}
        trailing={infoPin('tools', 'MCP tools')}
      />
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
      <ComposerMenuRow
        label="Usage"
        icon={<NumberOutlined />}
        value={usageValue}
        trailing={infoPin('tokens', 'usage')}
      />
      <ComposerMenuRow
        label="Context"
        icon={<PieChartOutlined />}
        value={
          contextPercent === null
            ? 'Unknown'
            : `${contextPercent}% of ${formatTokenCount(contextLimit)}`
        }
        trailing={infoPin('context', 'context')}
      />
      {contextPercent !== null && (
        <div style={{ paddingInline: token.paddingSM }}>
          <Progress
            percent={contextPercent}
            showInfo={false}
            size="small"
            strokeColor={contextColor}
            aria-label={`Context ${contextPercent}% used`}
          />
        </div>
      )}
      <ComposerMenuRow
        label="Session IDs"
        icon={<IdcardOutlined />}
        value={session.session_id.slice(0, 8)}
        trailing={infoPin('session-ids', 'session IDs')}
      />
      <ComposerMenuRow
        label="Copy session ID"
        icon={<CopyOutlined />}
        onClick={copyId(session.session_id, 'Session ID')}
      />
      {session.sdk_session_id && (
        <ComposerMenuRow
          label="Copy agent session ID"
          icon={<CopyOutlined />}
          onClick={copyId(session.sdk_session_id, 'Agent session ID')}
        />
      )}
      <ComposerMenuNote>
        Pin an item to show it in the info bar under the composer. MCP sign-in problems always show.
      </ComposerMenuNote>
    </>
  );
  const detailsContent =
    detailsPage === 'mcp' ? (
      <>
        <ComposerMenuBack label="Session details" onBack={() => setDetailsPage('main')} />
        <div style={{ padding: `0 ${token.paddingSM}px ${token.paddingXS}px` }}>
          <SessionMcpFooterControl
            inline
            client={client}
            currentUserId={currentUserId}
            sessionId={session.session_id}
            sessionMcpServerIds={sessionMcpServerIds}
            mcpServerById={mcpServerById}
            userAuthenticatedMcpServerIds={userAuthenticatedMcpServerIds}
          />
        </div>
      </>
    ) : (
      detailsMain
    );
  const openDetails = (menu: 'details' | 'details-context') => (open: boolean) => {
    setDetailsPage('main');
    setOpenMenu(open ? menu : null);
  };
  const infoTextStyle: React.CSSProperties = {
    height: isMobile ? MOBILE_TOUCH_TARGET : token.controlHeightSM,
    paddingInline: token.paddingXXS,
    fontSize: token.fontSizeSM,
    color: token.colorTextTertiary,
    minWidth: 0,
  };
  const showContextInInfo = contextPercent !== null && pinnedChips.includes('context');
  const infoLineVisible =
    (showContextInInfo || infoItems.length > 0 || signInWarning) && !(keyboardUp && !signInWarning);
  const infoLine = infoLineVisible && (
    <Flex
      align="center"
      style={{ minWidth: 0, paddingInline: token.paddingXS }}
      data-testid="composer-info-line"
    >
      {showContextInInfo && (
        <ComposerMenu
          sheet={isMobile}
          title="Session details"
          open={openMenu === 'details-context'}
          onOpenChange={openDetails('details-context')}
          content={detailsContent}
        >
          <Tooltip title="Context window">
            <Button
              type="text"
              size="small"
              aria-label={`Context ${contextPercent}% used. Session details`}
              onClick={isMobile ? () => openDetails('details-context')(true) : undefined}
              style={{ ...infoTextStyle, gap: token.sizeXXS }}
            >
              <Progress
                type="circle"
                size={token.fontSizeSM}
                percent={contextPercent ?? 0}
                showInfo={false}
                strokeWidth={16}
                strokeColor={contextColor}
                aria-hidden
              />
              {contextPercent}%
            </Button>
          </Tooltip>
        </ComposerMenu>
      )}
      {(infoItems.length > 0 || signInWarning) && (
        <ComposerMenu
          sheet={isMobile}
          title="Session details"
          open={openMenu === 'details'}
          onOpenChange={openDetails('details')}
          content={detailsContent}
        >
          <Button
            type="text"
            size="small"
            aria-label={`Session details. ${[...infoItems, signInWarning].filter(Boolean).join(', ')}`}
            onClick={isMobile ? () => openDetails('details')(true) : undefined}
            style={infoTextStyle}
          >
            <Typography.Text ellipsis style={{ fontSize: token.fontSizeSM, color: 'inherit' }}>
              {showContextInInfo && infoItems.length > 0 ? '· ' : ''}
              {infoItems.join(' · ')}
              {signInWarning && (
                <span style={{ color: token.colorWarningText }}>
                  {infoItems.length > 0 ? ' · ' : ''}
                  {signInWarning}
                </span>
              )}
            </Typography.Text>
          </Button>
        </ComposerMenu>
      )}
    </Flex>
  );

  const attachmentsHint = composerAttachmentsPresent
    ? 'Attachments only work with Send for now'
    : undefined;
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
  };
  const pinsFull = isMobile && pinnedItems.length >= COMPACT_PIN_LIMIT;
  const renderActionRow = (id: string) => {
    const row = actionRows[id];
    const pinned = pinnedItems.includes(id);
    return (
      <ComposerMenuRow
        key={id}
        label={row.label}
        hint={connectionDisabled ? LOST_CONNECTION_TOOLTIP : row.hint}
        icon={row.icon}
        disabled={row.disabled}
        onClick={runAction(row.onClick)}
        trailing={
          <ComposerPinToggle
            pinned={pinned}
            label={`${pinned ? 'Unpin' : 'Pin'} ${row.label}`}
            tooltip={pinned ? 'Unpin from bar' : 'Pin to bar'}
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
      sheet={isMobile}
      title="Add files and actions"
      open={openMenu === 'plus'}
      onOpenChange={(open) => {
        setPlusPage('main');
        setOpenMenu(open ? 'plus' : null);
      }}
      content={
        plusPage === 'details' ? (
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
      <Tooltip title="Add files and actions">
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
        <ComposerMenuNote>{GEMINI_MANUAL_MESSAGE}</ComposerMenuNote>
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
  const modelPageContent = (
    <>
      {presetNote}
      <ModelSelector
        key={session.session_id}
        value={modelConfig}
        onCommit={onModelConfigCommit}
        agentic_tool={session.agentic_tool}
        client={client}
        branchId={session.branch_id}
        catalogEnabled={session.created_by === currentUserId}
        compact
        showAdvisor={false}
        renderRows={({ options, currentModel, select }) => (
          <div role="radiogroup" aria-label="Model">
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
      {onOpenSessionSettings && (
        <ComposerMenuRow
          label="Session settings"
          icon={<SettingOutlined />}
          onClick={runAction(() => onOpenSessionSettings(session.session_id))}
        />
      )}
    </>
  );
  const modelMenuContent = modelPage === 'permissions' ? permissionsPage : modelPageContent;
  const openModelMenu = (menu: 'model' | 'permissions') => (open: boolean) => {
    setModelPage(menu === 'permissions' ? 'permissions' : 'model');
    setOpenMenu(open ? menu : null);
  };

  const modelChip = (
    <ComposerMenu
      sheet={isMobile}
      title="Model"
      open={openMenu === 'model'}
      onOpenChange={openModelMenu('model')}
      content={modelMenuContent}
    >
      <Tooltip title="Model and effort">
        <Button
          type="text"
          aria-label={modelChipAriaLabel}
          aria-haspopup="dialog"
          aria-expanded={openMenu === 'model'}
          onClick={isMobile ? () => openModelMenu('model')(true) : undefined}
          style={chipStyle}
          data-testid="model-chip"
        >
          <Typography.Text ellipsis style={{ minWidth: 0, fontSize: token.fontSize }}>
            {modelChipLabel}
          </Typography.Text>
        </Button>
      </Tooltip>
    </ComposerMenu>
  );

  const permissionChip = showPermissionChip && (
    <ComposerMenu
      sheet={isMobile}
      title="Permissions"
      open={openMenu === 'permissions'}
      onOpenChange={openModelMenu('permissions')}
      content={modelMenuContent}
    >
      <Tooltip title="Permissions">
        <Button
          type="text"
          aria-label={`Permissions: ${permissionChipName}. Change`}
          aria-haspopup="dialog"
          aria-expanded={openMenu === 'permissions'}
          onClick={isMobile ? () => openModelMenu('permissions')(true) : undefined}
          style={{ ...chipStyle, color: token.colorWarningText }}
          data-testid="permission-chip"
        >
          <Typography.Text ellipsis style={{ minWidth: 0, color: 'inherit' }}>
            {permissionChipLabel}
          </Typography.Text>
        </Button>
      </Tooltip>
    </ComposerMenu>
  );

  const workingLine = showStop && (
    <Flex
      align="center"
      gap={token.marginXS}
      style={{
        minHeight: isMobile ? token.controlHeight : token.controlHeightSM,
        paddingInlineEnd: token.paddingXXS,
        fontSize: token.fontSizeSM,
        color: token.colorTextSecondary,
      }}
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
      <span role="status" aria-label={showActivity ? 'Agent is working' : undefined}>
        {stopBusy ? 'Stopping' : 'Working'}
      </span>
      {workingElapsed}
      <span style={{ flex: 1 }} />
      {circleState !== 'stop' && (
        <Tooltip title={stopTooltip}>
          <Button
            type="text"
            size="small"
            aria-label="Stop the agent"
            aria-busy={stopBusy}
            loading={stopBusy}
            disabled={stopDisabled}
            onClick={onStop}
            style={{
              fontSize: token.fontSizeSM,
              ...(isMobile
                ? { minHeight: MOBILE_TOUCH_TARGET, minWidth: MOBILE_TOUCH_TARGET }
                : {}),
            }}
          >
            Stop
          </Button>
        </Tooltip>
      )}
    </Flex>
  );

  const pinnedRow = rowPins.map((id) => (
    <React.Fragment key={id}>{pinnedActionButtons[id]}</React.Fragment>
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

      <SessionComposerDropZone
        disabled={composerAttachmentUploading}
        onDragActiveChange={onDropActiveChange}
        onFilesDrop={onFilesDrop}
        radius={token.borderRadius * 2}
      >
        <div
          ref={cardRef}
          data-testid="composer-card"
          onFocus={() => setCardFocused(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setCardFocused(false);
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
          {workingLine}
          <Flex vertical gap={token.sizeXS} style={{ minWidth: 0 }}>
            {promptInputSlot}
          </Flex>
          <Flex align="center" gap={token.sizeXXS} style={{ minWidth: 0 }}>
            {plusButton}
            {pinnedRow}
            {modelChip}
            {permissionChip}
            <span style={{ flex: 1 }} />
            <Tooltip title={circleTooltip}>
              <Button
                {...circleVariant}
                shape="circle"
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
                  ) : circleState === 'queue' ? (
                    <UnorderedListOutlined />
                  ) : (
                    <ArrowUpOutlined />
                  )
                }
                // Keep the keyboard up on phones and focus in the text after a tap.
                onMouseDown={(event) => event.preventDefault()}
                onClick={
                  circleDisabled ? undefined : circleState === 'stop' ? onStop : onSendPrompt
                }
                style={{
                  width: controlSize,
                  height: controlSize,
                  minWidth: controlSize,
                  flexShrink: 0,
                  boxShadow: 'none',
                  transition: reducedMotion ? 'none' : undefined,
                  cursor: circleDisabled ? 'not-allowed' : undefined,
                }}
                data-testid="composer-circle"
              />
            </Tooltip>
          </Flex>
        </div>
      </SessionComposerDropZone>

      {infoLine}
    </div>
  );
};

export const SessionFooter = React.memo(SessionFooterInner);
SessionFooter.displayName = 'SessionFooter';
