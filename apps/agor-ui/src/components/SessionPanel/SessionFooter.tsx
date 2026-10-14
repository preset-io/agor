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
  ArrowUpOutlined,
  BranchesOutlined,
  ForkOutlined,
  LockOutlined,
  PaperClipOutlined,
  PlusOutlined,
  QuestionCircleOutlined,
  SettingOutlined,
  UnorderedListOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { Button, Divider, Flex, Segmented, Tag, Tooltip, Typography, theme } from 'antd';
import React from 'react';
import { useElementWidth } from '../../hooks/useElementWidth';
import { COMPACT_PIN_LIMIT, useFooterPreferences } from '../../hooks/useFooterPreferences';
import { useIsMobileViewport } from '../../hooks/useIsMobileViewport';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { LOST_CONNECTION_TOOLTIP } from '../../utils/connectionErrors';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { CompactNotice } from '../CompactNotice';
import { EFFORT_OPTIONS } from '../EffortSelector';
import { glassSurfaceStyle } from '../GlassSurface/glassStyles';
import type { ModelConfig } from '../ModelSelector';
import { ModelSelector } from '../ModelSelector';
import {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  getPermissionModeMeta,
  getPermissionModes,
} from '../PermissionModeSelector';
import { ContextWindowPill, TimerPill, useElapsedDuration } from '../Pill';
import { getModelChipLabel } from '../Pill/modelDisplay';
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

type ComposerMenuId = 'plus' | 'model' | 'permissions' | 'details';

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

  const [openMenu, setOpenMenu] = React.useState<ComposerMenuId | null>(null);
  const [modelPage, setModelPage] = React.useState<'model' | 'permissions'>('model');
  const runAction = (action: () => void) => () => {
    setOpenMenu(null);
    action();
  };
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
      {onOpenSessionSettings && (
        <>
          <Divider style={{ margin: `${token.marginXXS}px 0` }} />
          <ComposerMenuRow
            label="Session settings"
            icon={<SettingOutlined />}
            onClick={runAction(() => onOpenSessionSettings(session.session_id))}
          />
        </>
      )}
    </>
  );

  const plusButton = (
    <ComposerMenu
      sheet={isMobile}
      title="Add files and actions"
      open={openMenu === 'plus'}
      onOpenChange={(open) => setOpenMenu(open ? 'plus' : null)}
      content={plusMenuContent}
    >
      <Tooltip title="Add files and actions">
        <Button
          type="text"
          aria-label="Add files and actions"
          aria-haspopup="dialog"
          aria-expanded={openMenu === 'plus'}
          icon={<PlusOutlined />}
          onClick={isMobile ? () => setOpenMenu('plus') : undefined}
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
  const defaultTag = (
    <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
      default
    </Tag>
  );
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
          {plusButton}
          {pinnedRow}
          {modelChip}
          {permissionChip}
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
    </div>
  );
};

export const SessionFooter = React.memo(SessionFooterInner);
SessionFooter.displayName = 'SessionFooter';
