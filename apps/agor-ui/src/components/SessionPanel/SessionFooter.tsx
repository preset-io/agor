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
  BranchesOutlined,
  ClockCircleOutlined,
  EllipsisOutlined,
  ForkOutlined,
  IdcardOutlined,
  LockOutlined,
  NumberOutlined,
  PaperClipOutlined,
  PercentageOutlined,
  PushpinFilled,
  PushpinOutlined,
  QuestionCircleOutlined,
  RobotOutlined,
  SendOutlined,
  SettingOutlined,
  StopOutlined,
  ToolOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import {
  Badge,
  Button,
  Divider,
  Drawer,
  Flex,
  Popover,
  Space,
  Spin,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import React from 'react';
import { useFooterPreferences } from '../../hooks/useFooterPreferences';
import { useIsMobileViewport } from '../../hooks/useIsMobileViewport';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { reducedMotionSurface, usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { VISUALLY_HIDDEN_STYLE } from '../../utils/accessibility';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { CompactNotice } from '../CompactNotice';
import { EffortSelector } from '../EffortSelector';
import { glassSurfaceStyle } from '../GlassSurface/glassStyles';
import type { ModelConfig } from '../ModelSelector';
import { ModelSelector } from '../ModelSelector';
import { PermissionModeSelector } from '../PermissionModeSelector';
import { ContextWindowPill, TimerPill } from '../Pill';
import { getModelDisplayName } from '../Pill/modelDisplay';
import { SessionIdsList } from '../SessionIds';
import { Tag } from '../Tag';
import { RecoveryActions } from './RecoveryActions';
import { SessionMcpFooterControl } from './SessionMcpFooterControl';
import { SessionUsagePopover } from './SessionUsagePopover';

export interface SessionFooterProps {
  // Session data for chips
  session: Session & { agentic_tool: AgenticToolName };
  currentUserId?: string;
  footerTimerTask: Task | null;
  latestContextWindow: { used: number; limit: number; taskMetadata: unknown } | null;
  footerGradient?: string;
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

// Height of the mobile info-bar chips (MCP / effort / model) so they line up.
const MOBILE_CHIP_HEIGHT = 22;

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
  footerGradient,
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
  // Below the shell breakpoint the chip row collapses to a compact model+effort
  // bar and "More" opens a bottom sheet instead of a popover, so the full
  // controls stay reachable on a phone without a separate lossy composer.
  const isMobile = useIsMobileViewport();
  const reducedMotion = usePrefersReducedMotion();
  // Leave desktop pin preferences intact; secondary actions remain in More on
  // phones so they cannot push Stop/Queue outside the viewport.
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
  const [prefs, setPref] = useFooterPreferences();
  const pinnedItems = prefs.pinnedItems;
  // The phone bar keeps only Attach; the other pinned actions stay in the controls sheet.
  const barPinnedItems = isMobile ? pinnedItems.filter((item) => item === 'upload') : pinnedItems;
  const togglePin = (id: string) => {
    setPref({
      pinnedItems: pinnedItems.includes(id)
        ? pinnedItems.filter((p) => p !== id)
        : [...pinnedItems, id],
    });
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
  const modelChipMinWidth = token.controlHeight * 3;

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
  const controlSize = isMobile ? 'middle' : 'small';
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
  // Phones skip hover tooltips: a tap leaves them over the sheet and buttons.
  // Gated by viewport width, not pointer type, to match the phone layout switch.
  const hoverTooltip = (title: React.ReactNode) => (isMobile ? undefined : title);
  const pinToggle = (pinned: boolean, label: string, tooltip: string, onToggle: () => void) => (
    <Tooltip title={hoverTooltip(tooltip)} placement="right">
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
  const moreButton = (
    <Tooltip title={hoverTooltip('More options')}>
      <Button
        size={actionSize}
        style={touchActionStyle}
        type="text"
        icon={<EllipsisOutlined />}
        aria-label="More options"
        onClick={isMobile ? () => setMoreOpen(true) : undefined}
      />
    </Tooltip>
  );

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
          <div style={settingControlStyle}>{renderEffortSelector(controlSize)}</div>
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
            size={controlSize}
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
                ? 'Disconnected from daemon'
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
                ? 'Disconnected from daemon'
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
                ? 'Disconnected from daemon'
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
    ? 'Disconnected from daemon'
    : stopRequestInFlight
      ? 'Stopping...'
      : isStopping
        ? 'Agor is checking that the previous work has stopped.'
        : 'Stop';

  const recoveryFailed = recoveryTask?.sdk_failure?.termination === 'unverified';
  const showStop = !recoveryFailed && (isRunning || stopRequestInFlight);
  // isRunning also includes stopping for the action controls. Only advertise
  // active work here, not permission/input waits or a stale offline state.
  const showActivity =
    session.status === SessionStatus.RUNNING && !stopRequestInFlight && !connectionDisabled;

  const sendLabel = isRunning && hasInput ? 'Queue' : 'Send';
  const sendTooltip = connectionDisabled
    ? 'Disconnected from daemon'
    : composerAttachmentUploading
      ? composerUploadTooltip
      : isRunning
        ? 'Queue message'
        : 'Send';

  return (
    <div
      style={{
        position: 'relative',
        flexShrink: 0,
        background: token.colorBgContainer,
        borderTop: `1px solid ${token.colorBorder}`,
        // Keep all padding longhand: an undefined desktop paddingBottom clears
        // the bottom inset supplied by a padding shorthand in React.
        paddingTop: token.paddingXS,
        paddingInline: isMobile ? token.padding : token.paddingLG,
        paddingBottom: isMobile
          ? `max(${token.sizeUnit * 2}px, env(safe-area-inset-bottom))`
          : token.sizeUnit * 2,
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

      <div style={{ position: 'relative', zIndex: 1 }}>
        {/* Row 1: Info bar (always shown on mobile as the compact chip bar).
            Desktop wraps. Phones keep one line: the model chip truncates first,
            then the row scrolls. */}
        {(isMobile ||
          showMcpControl ||
          (footerTimerTask && pinnedChips.includes('timer')) ||
          (modelName && pinnedChips.includes('model')) ||
          pinnedChips.includes('tokens') ||
          (latestContextWindow &&
            latestContextWindow.limit > 0 &&
            pinnedChips.includes('context')) ||
          pinnedChips.includes('session-ids')) && (
          <div
            style={{
              display: 'flex',
              gap: token.sizeUnit,
              alignItems: 'center',
              marginBottom: token.sizeUnit * 2,
              ...(isMobile
                ? {
                    flexWrap: 'nowrap',
                    whiteSpace: 'nowrap',
                    overflowX: 'auto',
                    scrollbarWidth: 'none',
                  }
                : { flexWrap: 'wrap' }),
            }}
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

            {/* Compact effort control (mobile chip bar only) */}
            {isMobile && supportsLiveEffort && toolCaps?.reasoningEffortLevels && (
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  height: MOBILE_CHIP_HEIGHT,
                  pointerEvents: managedByPreset ? 'none' : undefined,
                  opacity: managedByPreset ? 0.65 : undefined,
                }}
              >
                {renderEffortSelector('small')}
              </div>
            )}

            {/* Model chip. On mobile it just opens the controls sheet, so there
                is no popover to render; desktop keeps the click-to-change popover. */}
            {modelName &&
              (isMobile ? (
                <Button
                  size="small"
                  icon={<RobotOutlined />}
                  onClick={() => setMoreOpen(true)}
                  aria-label={`Model and session controls: ${modelName}`}
                  title={modelName}
                  style={{
                    height: MOBILE_CHIP_HEIGHT,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: token.marginXXS,
                    minWidth: modelChipMinWidth,
                  }}
                  data-testid="model-chip"
                >
                  <Typography.Text ellipsis style={{ minWidth: 0, fontSize: token.fontSizeSM }}>
                    {modelName}
                  </Typography.Text>
                </Button>
              ) : (
                pinnedChips.includes('model') && (
                  <Popover
                    trigger={managedByPreset ? [] : 'click'}
                    placement="topLeft"
                    title="Model"
                    overlayStyle={{ maxWidth: 'none' }}
                    overlayInnerStyle={{ padding: 8 }}
                    content={
                      <div style={{ width: 420 }}>
                        {managedByPreset ? (
                          <Typography.Text>
                            Managed by preset. Switch presets in Session Settings.
                          </Typography.Text>
                        ) : (
                          <ModelSelector
                            key={session.session_id}
                            value={modelConfig}
                            onCommit={onModelConfigCommit}
                            agentic_tool={session.agentic_tool}
                            client={client}
                            branchId={session.branch_id}
                            catalogEnabled={session.created_by === currentUserId}
                          />
                        )}
                      </div>
                    }
                  >
                    <Tag
                      icon={<RobotOutlined />}
                      color="default"
                      truncate
                      title={modelName}
                      style={{
                        cursor: managedByPreset ? 'default' : 'pointer',
                        height: 22,
                        display: 'inline-flex',
                        alignItems: 'center',
                        minWidth: modelChipMinWidth,
                      }}
                      data-testid="model-chip"
                    >
                      {modelName}
                    </Tag>
                  </Popover>
                )
              ))}

            {pinnedChips.includes('tokens') && (
              <SessionUsagePopover
                key={`${session.session_id}:${currentUserId}`}
                client={client ?? null}
                sessionId={session.session_id}
                userId={currentUserId}
              />
            )}

            {/* Context % chip */}
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

            {/* Session IDs chip */}
            {pinnedChips.includes('session-ids') && (
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
                <Tag
                  icon={<IdcardOutlined />}
                  color="default"
                  style={{
                    cursor: 'pointer',
                    height: 22,
                    display: 'inline-flex',
                    alignItems: 'center',
                  }}
                  data-testid="session-ids-chip"
                >
                  IDs
                </Tag>
              </Popover>
            )}
          </div>
        )}

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

        {/* Row 2 — Prompt textarea (inline in the action bar on phones). Crossing
            the breakpoint remounts PromptInput; its unmount saveDraft keeps the text. */}
        {!isMobile && promptInputSlot}

        {/* Row 3 — Action bar. On phones it is a chat bar: the input grows
            upward and the buttons stay aligned with its last line. */}
        <div
          style={{
            display: 'flex',
            flexWrap: isMobile ? 'nowrap' : 'wrap',
            alignItems: isMobile ? 'flex-end' : 'center',
            gap: token.sizeUnit,
            marginTop: isMobile ? 0 : token.sizeUnit * 2,
          }}
        >
          {/* Left group */}
          <Space size={4}>
            {barPinnedItems.includes('upload') && (
              <Tooltip
                title={hoverTooltip(
                  composerAttachmentUploading
                    ? composerUploadTooltip
                    : connectionDisabled
                      ? 'Disconnected from daemon'
                      : 'Attach files'
                )}
              >
                <Button
                  size={actionSize}
                  style={touchActionStyle}
                  type="text"
                  aria-label="Attach files"
                  title="Attach files"
                  icon={<PaperClipOutlined />}
                  onClick={onAttachFiles}
                  disabled={uploadDisabled}
                  data-testid="upload-bar-btn"
                />
              </Tooltip>
            )}
            {barPinnedItems.includes('advanced-upload') && (
              <Tooltip
                title={hoverTooltip(
                  composerAttachmentUploading
                    ? composerUploadTooltip
                    : connectionDisabled
                      ? 'Disconnected from daemon'
                      : 'Advanced upload'
                )}
              >
                <Button
                  size={actionSize}
                  style={touchActionStyle}
                  type="text"
                  aria-label="Advanced upload"
                  title="Advanced upload"
                  icon={<UploadOutlined />}
                  onClick={onUploadOpen}
                  disabled={advancedUploadDisabled}
                />
              </Tooltip>
            )}
            {barPinnedItems.includes('fork') && toolCaps?.supportsSessionFork !== false && (
              <Tooltip
                title={hoverTooltip(
                  connectionDisabled ? 'Disconnected from daemon' : 'Fork Session'
                )}
              >
                <Button
                  size={actionSize}
                  style={touchActionStyle}
                  type="text"
                  aria-label="Fork session"
                  icon={<ForkOutlined />}
                  onClick={onFork}
                  disabled={forkDisabled}
                  data-testid="fork-bar-btn"
                />
              </Tooltip>
            )}
            {/* Dynamically pinned items */}
            {barPinnedItems.includes('btw-fork') && toolCaps?.supportsSessionFork !== false && (
              <Tooltip title={hoverTooltip('BTW fork')}>
                <Button
                  size={actionSize}
                  style={touchActionStyle}
                  type="text"
                  aria-label="Ask side question via BTW fork"
                  icon={<QuestionCircleOutlined />}
                  onClick={onBtwSend}
                  disabled={btwForkDisabled}
                  data-testid="btw-fork-bar-btn"
                />
              </Tooltip>
            )}
            {barPinnedItems.includes('spawn') && toolCaps?.supportsChildSpawn !== false && (
              <Tooltip title={hoverTooltip('Spawn subsession')}>
                <Button
                  size={actionSize}
                  style={touchActionStyle}
                  type="text"
                  aria-label="Spawn subsession"
                  icon={<BranchesOutlined />}
                  onClick={onSpawnOpen}
                  disabled={spawnDisabled}
                />
              </Tooltip>
            )}
            {isMobile ? (
              moreButton
            ) : (
              <Popover
                open={moreOpen}
                onOpenChange={setMoreOpen}
                trigger="click"
                placement="topLeft"
                content={moreContent}
                title={null}
              >
                {moreButton}
              </Popover>
            )}
          </Space>

          {isMobile && <div style={{ flex: 1, minWidth: 0 }}>{promptInputSlot}</div>}

          {/* Right group */}
          <Flex
            align="center"
            gap={token.marginXS}
            style={{ marginInlineStart: 'auto', flexShrink: 0 }}
          >
            {/* Reserve the compact slot so activity changes never move controls.
                Phones keep it for screen readers only; Stop already shows work.
                Spin inherits the shared reduced-motion rule in index.css. */}
            <Flex
              align="center"
              justify="center"
              style={
                isMobile ? VISUALLY_HIDDEN_STYLE : { width: token.controlHeightXS, flexShrink: 0 }
              }
            >
              {showActivity && (
                <span role="status" aria-label="Agent is working" style={{ display: 'flex' }}>
                  <Spin size="small" aria-hidden="true" />
                </span>
              )}
            </Flex>
            {/* Flex avoids inline baseline/descender space around the controls. */}
            <Flex align="center" gap={token.sizeUnit}>
              {showStop && (
                <Tooltip title={hoverTooltip(stopTooltip)}>
                  <Button
                    danger
                    aria-label={
                      recoveryTask?.termination_request?.cause === 'user_stop'
                        ? 'Stopping'
                        : isStopping
                          ? 'Recovering'
                          : 'Stop'
                    }
                    aria-busy={stopRequestInFlight || isStopping}
                    size={actionSize}
                    style={touchActionStyle}
                    icon={
                      stopRequestInFlight || isStopping ? <Spin size="small" /> : <StopOutlined />
                    }
                    onClick={onStop}
                    disabled={connectionDisabled || !isRunning || stopRequestInFlight || isStopping}
                  />
                </Tooltip>
              )}
              <Tooltip title={hoverTooltip(sendTooltip)}>
                <Badge
                  count={queuedTasks.length > 0 ? queuedTasks.length : 0}
                  size="small"
                  offset={[-2, 2]}
                  styles={{ root: { display: 'inline-flex' } }}
                  style={{
                    boxShadow: 'none',
                    backgroundColor: token.colorTextTertiary,
                    fontSize: 10,
                  }}
                >
                  <Button
                    type="primary"
                    aria-label={sendLabel}
                    size={actionSize}
                    style={touchActionStyle}
                    icon={<SendOutlined />}
                    onClick={onSendPrompt}
                    disabled={sendDisabled}
                  />
                </Badge>
              </Tooltip>
            </Flex>
          </Flex>
        </div>
      </div>

      {/* Mobile: the "More" popover becomes a bottom sheet so the full control
          set (model / effort / permissions / attach / fork / spawn / btw /
          info-bar toggles / session settings) stays reachable on a phone. */}
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
