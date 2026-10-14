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
import { getDefaultModelForTool, SessionStatus } from '@agor-live/client';
import {
  ArrowUpOutlined,
  BranchesOutlined,
  ClockCircleOutlined,
  ForkOutlined,
  IdcardOutlined,
  LockOutlined,
  NumberOutlined,
  PaperClipOutlined,
  PercentageOutlined,
  PlusOutlined,
  PushpinFilled,
  PushpinOutlined,
  QuestionCircleOutlined,
  RobotOutlined,
  SettingOutlined,
  ToolOutlined,
  UnorderedListOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { Button, Divider, Drawer, Flex, Popover, Tooltip, Typography, theme } from 'antd';
import React from 'react';
import { useElementWidth } from '../../hooks/useElementWidth';
import { COMPACT_PIN_LIMIT, useFooterPreferences } from '../../hooks/useFooterPreferences';
import { useIsMobileViewport } from '../../hooks/useIsMobileViewport';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { reducedMotionSurface, usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { LOST_CONNECTION_TOOLTIP } from '../../utils/connectionErrors';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { CompactNotice } from '../CompactNotice';
import { EFFORT_OPTIONS, EffortSelector } from '../EffortSelector';
import { glassSurfaceStyle } from '../GlassSurface/glassStyles';
import type { ModelConfig } from '../ModelSelector';
import { ModelSelector } from '../ModelSelector';
import { getPermissionModeMeta, PermissionModeSelector } from '../PermissionModeSelector';
import { ContextWindowPill, TimerPill, useElapsedDuration } from '../Pill';
import { getModelChipLabel, getModelDisplayName } from '../Pill/modelDisplay';
import { SessionIdsList } from '../SessionIds';
import {
  getComposerCircleState,
  isPermissionNonDefault,
  NARROW_COMPOSER_WIDTH,
  splitPinnedActions,
} from './composerState';
import { RecoveryActions } from './RecoveryActions';
import { SessionMcpFooterControl } from './SessionMcpFooterControl';
import { SessionUsagePopover } from './SessionUsagePopover';

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
  // Prompt textarea rendered between the two bars
  promptInputSlot: React.ReactNode;
}

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
}) => {
  const managedByPreset = Boolean(session.agentic_tool_preset_id);
  const supportsLiveEffort = Boolean(toolCaps?.reasoningEffortLevels?.length);
  const { token } = theme.useToken();
  // One card at every width: phones get 44px targets and bottom sheets,
  // desktop gets 32px controls and popovers anchored to their trigger.
  const isMobile = useIsMobileViewport();
  const reducedMotion = usePrefersReducedMotion();
  const actionSize = isMobile ? 'middle' : 'small';
  const touchActionStyle: React.CSSProperties | undefined = isMobile
    ? { minHeight: MOBILE_TOUCH_TARGET, minWidth: MOBILE_TOUCH_TARGET }
    : undefined;
  const [moreOpen, setMoreOpen] = React.useState(false);
  const moreContentRef = React.useRef<HTMLFieldSetElement>(null);
  const getMorePopupContainer = React.useCallback(
    (triggerNode: HTMLElement) =>
      moreContentRef.current ?? triggerNode.parentElement ?? triggerNode,
    []
  );
  const cardRef = React.useRef<HTMLDivElement>(null);
  const cardWidth = useElementWidth(cardRef);
  const narrow = !isMobile && cardWidth > 0 && cardWidth < NARROW_COMPOSER_WIDTH;
  const [cardFocused, setCardFocused] = React.useState(false);
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
  const { row: rowPins } = splitPinnedActions(
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
  const modelName = effectiveModel
    ? getModelDisplayName(
        session.model_config?.provider
          ? `${session.model_config.provider}/${effectiveModel}`
          : effectiveModel
      )
    : null;
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
  const showMcpControl = pinnedChips.includes('tools') || unauthedMcpServers.length > 0;
  const mcpNoticeMessage =
    unauthedMcpServers.length === 1
      ? `${unauthedMcpServers[0].display_name || unauthedMcpServers[0].name} isn’t connected. Open the MCP badge to connect it.`
      : `${unauthedMcpServers.length} MCP servers aren’t connected. Open the MCP badge to connect them.`;

  const composerAttachmentActionTooltip = 'Attachments are only supported for normal Send for now';
  const composerUploadTooltip = 'Uploading files...';
  const uploadDisabled = connectionDisabled || composerAttachmentUploading;
  const advancedUploadDisabled = uploadDisabled;
  const forkDisabled = connectionDisabled || composerAttachmentsPresent;
  const btwForkDisabled = connectionDisabled || !hasInput || composerAttachmentsPresent;
  const spawnDisabled = connectionDisabled || isRunning || composerAttachmentsPresent;
  const sendDisabled = connectionDisabled || composerAttachmentUploading || !hasInput;

  // Overflow menu scale: one row height, one label size, one control height.
  const rowHeight = isMobile ? MOBILE_TOUCH_TARGET : token.controlHeight;
  const controlHeight = isMobile ? token.controlHeight : token.controlHeightSM;
  const labelFontSize = isMobile ? token.fontSize : token.fontSizeSM;

  const sectionHeaderStyle: React.CSSProperties = {
    padding: `${token.paddingXS}px ${token.paddingSM}px ${token.paddingXXS}px`,
    fontSize: token.fontSizeSM,
    fontWeight: token.fontWeightStrong,
    color: token.colorTextTertiary,
    userSelect: 'none',
  };

  const overflowRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: token.marginXS,
    padding: `0 ${token.paddingXXS}px 0 ${token.paddingSM}px`,
    height: rowHeight,
  };
  // Label stays on the first control line even when a control grows taller.
  const settingRowStyle: React.CSSProperties = {
    ...overflowRowStyle,
    height: 'auto',
    minHeight: rowHeight,
    boxSizing: 'border-box',
    paddingBlock: (rowHeight - controlHeight) / 2,
    alignItems: 'flex-start',
    cursor: 'default',
  };
  const labelGroupStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: token.marginXS,
    flex: 1,
    minWidth: 0,
    height: controlHeight,
  };
  const settingNameStyle: React.CSSProperties = { ...labelGroupStyle, minWidth: 'max-content' };
  const settingControlStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'flex-end',
    alignItems: 'center',
    minHeight: controlHeight,
    flex: 2,
    minWidth: 0,
    pointerEvents: managedByPreset ? 'none' : undefined,
    opacity: managedByPreset ? 0.65 : undefined,
  };
  const iconStyle: React.CSSProperties = {
    fontSize: token.fontSize,
    color: token.colorTextSecondary,
    flexShrink: 0,
  };
  const labelStyle: React.CSSProperties = {
    fontSize: labelFontSize,
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };
  const pinToggle = (pinned: boolean, label: string, tooltip: string, onToggle: () => void) => (
    <Tooltip title={tooltip} placement="right">
      <Button
        type="text"
        size={actionSize}
        aria-label={label}
        style={{
          ...touchActionStyle,
          flexShrink: 0,
          color: pinned ? token.colorPrimary : token.colorTextTertiary,
        }}
        icon={
          pinned ? (
            <PushpinFilled style={{ fontSize: token.fontSizeSM }} />
          ) : (
            <PushpinOutlined style={{ fontSize: token.fontSizeSM }} />
          )
        }
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      />
    </Tooltip>
  );
  const itemPin = (id: string, name: string) =>
    pinToggle(
      pinnedItems.includes(id),
      `${pinnedItems.includes(id) ? 'Unpin' : 'Pin'} ${name}`,
      pinnedItems.includes(id) ? 'Unpin from bar' : 'Pin to bar',
      () => togglePin(id)
    );
  const chipPin = (id: string, name: string) =>
    pinToggle(
      pinnedChips.includes(id),
      `${pinnedChips.includes(id) ? 'Hide' : 'Show'} ${name}`,
      pinnedChips.includes(id) ? 'Hide from info bar' : 'Show in info bar',
      () => toggleChip(id)
    );

  // One effort control, shown in the controls panel and again in the phone chip bar.
  const renderEffortSelector = (size: 'small' | 'middle') =>
    toolCaps?.reasoningEffortLevels ? (
      <EffortSelector
        value={effortLevel}
        onChange={onEffortChange}
        levels={toolCaps.reasoningEffortLevels}
        fallbackValue={toolCaps.defaultReasoningEffort}
        allowInherited={!toolCaps.defaultReasoningEffort}
        size={size}
        compact
        plain
      />
    ) : null;
  const moreContent = (
    <fieldset
      ref={moreContentRef}
      aria-label="More options"
      onMouseDown={(event) => event.stopPropagation()}
      style={{
        width: isMobile ? '100%' : 260,
        minWidth: 0,
        padding: '6px 0',
        margin: 0,
        border: 0,
      }}
    >
      <div style={sectionHeaderStyle}>Settings</div>

      <div style={settingRowStyle}>
        <span style={settingNameStyle}>
          <RobotOutlined style={iconStyle} />
          <Typography.Text style={{ ...labelStyle, color: token.colorTextSecondary }}>
            Model
          </Typography.Text>
        </span>
        <div
          style={settingControlStyle}
          title={
            managedByPreset ? 'Managed by preset; switch presets in Session Settings' : undefined
          }
        >
          <div style={{ width: '100%', minWidth: 0 }}>
            <ModelSelector
              key={session.session_id}
              value={modelConfig}
              onCommit={onModelConfigCommit}
              agentic_tool={session.agentic_tool}
              client={client}
              branchId={session.branch_id}
              catalogEnabled={session.created_by === currentUserId}
              compact={!isMobile}
              getPopupContainer={getMorePopupContainer}
            />
          </div>
        </div>
      </div>

      {supportsLiveEffort && (
        <div style={settingRowStyle}>
          <span style={settingNameStyle}>
            <PercentageOutlined style={iconStyle} />
            <Typography.Text style={{ ...labelStyle, color: token.colorTextSecondary }}>
              Effort
            </Typography.Text>
          </span>
          <div style={settingControlStyle}>{renderEffortSelector(actionSize)}</div>
        </div>
      )}

      <div style={settingRowStyle}>
        <span style={settingNameStyle}>
          <LockOutlined style={iconStyle} />
          <Typography.Text style={{ ...labelStyle, color: token.colorTextSecondary }}>
            Permissions
          </Typography.Text>
        </span>
        <div style={settingControlStyle}>
          <PermissionModeSelector
            value={permissionMode}
            onChange={onPermissionModeChange}
            agentic_tool={session.agentic_tool}
            codexSandboxMode={codexSandboxMode}
            codexApprovalPolicy={codexApprovalPolicy}
            onCodexChange={onCodexPermissionChange}
            compact
            iconOnly={false}
            plain
            size={actionSize}
          />
        </div>
      </div>

      <Divider style={{ margin: `${token.marginXXS}px 0` }} />

      <div style={sectionHeaderStyle}>Actions</div>

      {/* biome-ignore lint/a11y/useSemanticElements: row contains a nested pin <button>; can't use <button> as parent */}
      <div
        role="button"
        tabIndex={uploadDisabled ? -1 : 0}
        style={{
          ...overflowRowStyle,
          opacity: uploadDisabled ? 0.4 : 1,
          cursor: uploadDisabled ? 'not-allowed' : 'pointer',
        }}
        onClick={
          uploadDisabled
            ? undefined
            : () => {
                setMoreOpen(false);
                onAttachFiles();
              }
        }
        onKeyDown={
          uploadDisabled
            ? undefined
            : (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setMoreOpen(false);
                  onAttachFiles();
                }
              }
        }
      >
        <Tooltip
          title={
            composerAttachmentUploading
              ? composerUploadTooltip
              : connectionDisabled
                ? LOST_CONNECTION_TOOLTIP
                : 'Attach files to prompt'
          }
          placement="left"
        >
          <span style={labelGroupStyle}>
            <PaperClipOutlined style={iconStyle} />
            <Typography.Text style={labelStyle}>Attach files</Typography.Text>
          </span>
        </Tooltip>
        {itemPin('upload', 'Upload')}
      </div>

      {/* biome-ignore lint/a11y/useSemanticElements: row contains a nested pin <button>; can't use <button> as parent */}
      <div
        role="button"
        tabIndex={advancedUploadDisabled ? -1 : 0}
        style={{
          ...overflowRowStyle,
          opacity: advancedUploadDisabled ? 0.4 : 1,
          cursor: advancedUploadDisabled ? 'not-allowed' : 'pointer',
        }}
        onClick={
          advancedUploadDisabled
            ? undefined
            : () => {
                setMoreOpen(false);
                onUploadOpen();
              }
        }
        onKeyDown={
          advancedUploadDisabled
            ? undefined
            : (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setMoreOpen(false);
                  onUploadOpen();
                }
              }
        }
      >
        <Tooltip
          title={
            composerAttachmentUploading
              ? composerUploadTooltip
              : connectionDisabled
                ? LOST_CONNECTION_TOOLTIP
                : 'Upload files with options'
          }
          placement="left"
        >
          <span style={labelGroupStyle}>
            <UploadOutlined style={iconStyle} />
            <Typography.Text style={labelStyle}>Advanced upload</Typography.Text>
          </span>
        </Tooltip>
        {itemPin('advanced-upload', 'Advanced upload')}
      </div>

      {toolCaps?.supportsSessionFork !== false && (
        // biome-ignore lint/a11y/useSemanticElements: row contains a nested pin <button>; can't use <button> as parent
        <div
          role="button"
          aria-disabled={forkDisabled}
          aria-label="Fork session"
          tabIndex={forkDisabled ? -1 : 0}
          style={{
            ...overflowRowStyle,
            opacity: forkDisabled ? 0.4 : 1,
            cursor: forkDisabled ? 'not-allowed' : 'pointer',
          }}
          onClick={
            forkDisabled
              ? undefined
              : () => {
                  setMoreOpen(false);
                  onFork();
                }
          }
          onKeyDown={
            forkDisabled
              ? undefined
              : (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setMoreOpen(false);
                    onFork();
                  }
                }
          }
        >
          <Tooltip
            title={
              connectionDisabled
                ? LOST_CONNECTION_TOOLTIP
                : composerAttachmentsPresent
                  ? composerAttachmentActionTooltip
                  : 'Fork this session'
            }
            placement="left"
          >
            <span style={labelGroupStyle}>
              <ForkOutlined style={iconStyle} />
              <Typography.Text style={labelStyle}>Fork session</Typography.Text>
            </span>
          </Tooltip>
          {itemPin('fork', 'Fork')}
        </div>
      )}

      {toolCaps?.supportsSessionFork !== false && (
        // biome-ignore lint/a11y/useSemanticElements: row contains a nested pin <button>; can't use <button> as parent
        <div
          role="button"
          aria-disabled={btwForkDisabled}
          aria-label="Ask side question via BTW fork"
          tabIndex={btwForkDisabled ? -1 : 0}
          style={{
            ...overflowRowStyle,
            opacity: btwForkDisabled ? 0.4 : 1,
            cursor: btwForkDisabled ? 'not-allowed' : 'pointer',
          }}
          onClick={
            btwForkDisabled
              ? undefined
              : () => {
                  setMoreOpen(false);
                  onBtwSend();
                }
          }
          onKeyDown={
            btwForkDisabled
              ? undefined
              : (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setMoreOpen(false);
                    onBtwSend();
                  }
                }
          }
        >
          <Tooltip
            title={
              composerAttachmentsPresent
                ? composerAttachmentActionTooltip
                : connectionDisabled || !hasInput
                  ? 'Needs input and a live connection'
                  : 'Ask a side question via an ephemeral fork'
            }
            placement="left"
          >
            <span style={labelGroupStyle}>
              <QuestionCircleOutlined style={iconStyle} />
              <Typography.Text style={labelStyle}>BTW fork</Typography.Text>
            </span>
          </Tooltip>
          {itemPin('btw-fork', 'BTW fork')}
        </div>
      )}

      {toolCaps?.supportsChildSpawn !== false && (
        // biome-ignore lint/a11y/useSemanticElements: row contains a nested pin <button>; can't use <button> as parent
        <div
          role="button"
          aria-disabled={spawnDisabled}
          aria-label="Spawn subsession"
          tabIndex={spawnDisabled ? -1 : 0}
          style={{
            ...overflowRowStyle,
            opacity: spawnDisabled ? 0.4 : 1,
            cursor: spawnDisabled ? 'not-allowed' : 'pointer',
          }}
          onClick={
            spawnDisabled
              ? undefined
              : () => {
                  setMoreOpen(false);
                  onSpawnOpen();
                }
          }
          onKeyDown={
            spawnDisabled
              ? undefined
              : (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setMoreOpen(false);
                    onSpawnOpen();
                  }
                }
          }
        >
          <Tooltip
            title={
              connectionDisabled
                ? 'Disconnected'
                : composerAttachmentsPresent
                  ? composerAttachmentActionTooltip
                  : isRunning
                    ? 'Session is running'
                    : 'Spawn a child subsession'
            }
            placement="left"
          >
            <span style={labelGroupStyle}>
              <BranchesOutlined style={iconStyle} />
              <Typography.Text style={labelStyle}>Spawn subsession</Typography.Text>
            </span>
          </Tooltip>
          {itemPin('spawn', 'Spawn')}
        </div>
      )}

      <Divider style={{ margin: `${token.marginXXS}px 0` }} />

      <div style={sectionHeaderStyle}>Info bar</div>

      {footerTimerTask && (
        <div style={{ ...overflowRowStyle, cursor: 'default' }}>
          <ClockCircleOutlined style={iconStyle} />
          <Typography.Text style={labelStyle}>Timer</Typography.Text>
          {chipPin('timer', 'timer')}
        </div>
      )}

      <div style={{ ...overflowRowStyle, cursor: 'default' }}>
        <ToolOutlined style={iconStyle} />
        <Typography.Text style={labelStyle}>Tools</Typography.Text>
        {chipPin('tools', 'tools')}
      </div>

      {modelName && (
        <div style={{ ...overflowRowStyle, cursor: 'default' }}>
          <RobotOutlined style={iconStyle} />
          <Typography.Text style={labelStyle}>Model</Typography.Text>
          {chipPin('model', 'model')}
        </div>
      )}

      <div style={{ ...overflowRowStyle, cursor: 'default' }}>
        <NumberOutlined style={iconStyle} />
        <Typography.Text style={labelStyle}>Usage</Typography.Text>
        {chipPin('tokens', 'usage')}
      </div>

      {latestContextWindow && latestContextWindow.limit > 0 && (
        <div style={{ ...overflowRowStyle, cursor: 'default' }}>
          <PercentageOutlined style={iconStyle} />
          <Typography.Text style={labelStyle}>Context %</Typography.Text>
          {chipPin('context', 'context')}
        </div>
      )}

      <Divider style={{ margin: `${token.marginXXS}px 0` }} />

      <Popover
        trigger="click"
        placement="topLeft"
        title={
          <span>
            <IdcardOutlined style={{ marginRight: 8 }} />
            Session IDs
          </span>
        }
        content={
          <div style={{ width: 400, maxWidth: '90vw' }}>
            <SessionIdsList session={session} />
          </div>
        }
      >
        {/* biome-ignore lint/a11y/useSemanticElements: row contains a nested pin <button>; can't use <button> as parent */}
        <div
          role="button"
          tabIndex={0}
          style={{ ...overflowRowStyle, cursor: 'pointer' }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.currentTarget.click();
            }
          }}
        >
          <IdcardOutlined style={iconStyle} />
          <Typography.Text style={labelStyle}>Session IDs</Typography.Text>
          {chipPin('session-ids', 'session IDs')}
        </div>
      </Popover>

      {onOpenSessionSettings && (
        <>
          <Divider style={{ margin: `${token.marginXXS}px 0` }} />
          <Button
            block
            type="text"
            icon={<SettingOutlined style={{ fontSize: token.fontSize }} />}
            aria-label="Session settings"
            style={{
              height: rowHeight,
              justifyContent: 'flex-start',
              paddingInline: token.paddingSM,
              fontSize: labelFontSize,
            }}
            onClick={() => {
              setMoreOpen(false);
              onOpenSessionSettings(session.session_id);
            }}
          >
            Session settings
          </Button>
        </>
      )}
    </fieldset>
  );

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
  const circleVisual: React.CSSProperties =
    circleState === 'stop' && !circleDisabled
      ? { background: token.colorText, color: token.colorBgContainer, borderColor: 'transparent' }
      : circleDisabled
        ? {
            background: token.colorFillSecondary,
            color: token.colorTextTertiary,
            borderColor: 'transparent',
            cursor: 'not-allowed',
          }
        : {};

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

  const plusButton = (
    <Tooltip title="Add files and actions">
      <Button
        type="text"
        aria-label="Add files and actions"
        aria-haspopup="dialog"
        aria-expanded={moreOpen}
        icon={<PlusOutlined />}
        onClick={isMobile ? () => setMoreOpen(true) : undefined}
        style={rowButtonStyle}
      />
    </Tooltip>
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
        paddingBottom: token.paddingXS,
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
          border: `${token.lineWidth}px ${token.lineType} ${
            cardFocused ? token.colorPrimary : token.colorBorder
          }`,
          boxShadow: cardFocused
            ? `0 0 0 ${token.controlOutlineWidth}px ${token.controlOutline}`
            : undefined,
          padding: `${token.paddingXXS + 2}px ${token.paddingXXS + 2}px ${token.paddingXXS + 2}px ${token.paddingSM}px`,
          transition: reducedMotion ? undefined : `border-color ${token.motionDurationFast}`,
        }}
      >
        {workingLine}
        <div style={{ minWidth: 0 }}>{promptInputSlot}</div>
        <Flex align="center" gap={token.sizeXXS} style={{ minWidth: 0 }}>
          {isMobile ? (
            plusButton
          ) : (
            <Popover
              open={moreOpen}
              onOpenChange={setMoreOpen}
              trigger="click"
              placement="topLeft"
              content={moreContent}
              title={null}
            >
              {plusButton}
            </Popover>
          )}
          {pinnedRow}
          <Tooltip title="Model and effort">
            <Button
              type="text"
              aria-label={modelChipAriaLabel}
              onClick={() => setMoreOpen(true)}
              style={chipStyle}
              data-testid="model-chip"
            >
              <Typography.Text ellipsis style={{ minWidth: 0, fontSize: token.fontSize }}>
                {modelChipLabel}
              </Typography.Text>
            </Button>
          </Tooltip>
          {showPermissionChip && (
            <Tooltip title="Permissions">
              <Button
                type="text"
                aria-label={`Permissions: ${permissionChipName}. Change`}
                onClick={() => setMoreOpen(true)}
                style={{ ...chipStyle, color: token.colorWarningText }}
                data-testid="permission-chip"
              >
                <Typography.Text ellipsis style={{ minWidth: 0, color: 'inherit' }}>
                  {permissionChipLabel}
                </Typography.Text>
              </Button>
            </Tooltip>
          )}
          <span style={{ flex: 1 }} />
          <Tooltip title={circleTooltip}>
            <Button
              type="primary"
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
              onClick={circleDisabled ? undefined : circleState === 'stop' ? onStop : onSendPrompt}
              style={{
                width: controlSize,
                height: controlSize,
                minWidth: controlSize,
                flexShrink: 0,
                boxShadow: 'none',
                transition: reducedMotion ? 'none' : undefined,
                ...circleVisual,
              }}
              data-testid="composer-circle"
            />
          </Tooltip>
        </Flex>
      </div>

      {/* Info bar (replaced by the info line in a later step) */}
      {(showMcpControl ||
        (footerTimerTask && pinnedChips.includes('timer')) ||
        pinnedChips.includes('tokens') ||
        (latestContextWindow && latestContextWindow.limit > 0 && pinnedChips.includes('context')) ||
        pinnedChips.includes('session-ids')) && (
        <Flex
          align="center"
          gap={token.sizeUnit}
          wrap
          style={{ marginTop: token.marginXXS, paddingInline: token.paddingXS }}
          data-testid="info-bar"
        >
          {footerTimerTask && pinnedChips.includes('timer') && (
            <div
              style={{ display: 'inline-flex', alignItems: 'center', height: 22 }}
              data-testid="timer-chip"
            >
              <TimerPill
                status={footerTimerTask.status}
                startedAt={
                  footerTimerTask.message_range?.start_timestamp || footerTimerTask.created_at
                }
                endedAt={
                  footerTimerTask.message_range?.end_timestamp || footerTimerTask.completed_at
                }
                durationMs={footerTimerTask.duration_ms}
                lastExecutorHeartbeatAt={footerTimerTask.last_executor_heartbeat_at}
                latestExecutorPulse={footerTimerTask.latest_executor_pulse}
              />
            </div>
          )}
          {showMcpControl && (
            <SessionMcpFooterControl
              client={client}
              currentUserId={currentUserId}
              sessionId={session.session_id}
              sessionMcpServerIds={sessionMcpServerIds}
              mcpServerById={mcpServerById}
              userAuthenticatedMcpServerIds={userAuthenticatedMcpServerIds}
            />
          )}
          {pinnedChips.includes('tokens') && (
            <SessionUsagePopover
              key={`${session.session_id}:${currentUserId}`}
              client={client ?? null}
              sessionId={session.session_id}
              userId={currentUserId}
            />
          )}
          {latestContextWindow &&
            latestContextWindow.limit > 0 &&
            pinnedChips.includes('context') && (
              <ContextWindowPill
                used={latestContextWindow.used}
                limit={latestContextWindow.limit}
                taskMetadata={
                  latestContextWindow.taskMetadata as React.ComponentProps<
                    typeof ContextWindowPill
                  >['taskMetadata']
                }
              />
            )}
        </Flex>
      )}

      {isMobile && (
        <Drawer
          open={moreOpen}
          onClose={() => setMoreOpen(false)}
          placement="bottom"
          height="85%"
          title="Session controls"
          {...reducedMotionSurface(reducedMotion)}
          styles={{
            content: glassSurfaceStyle(token, 0.85),
            body: { padding: 0, paddingBottom: 'env(safe-area-inset-bottom)', overflowY: 'auto' },
          }}
        >
          {moreContent}
        </Drawer>
      )}
    </div>
  );
};

export const SessionFooter = React.memo(SessionFooterInner);
SessionFooter.displayName = 'SessionFooter';
