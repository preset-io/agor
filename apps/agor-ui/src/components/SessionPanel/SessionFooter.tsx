import type {
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
import { Badge, Button, Divider, Popover, Space, Spin, Tooltip, Typography, theme } from 'antd';
import React from 'react';
import { useFooterPreferences } from '../../hooks/useFooterPreferences';
import { resolveContextWindowPercentage } from '../../utils/contextWindow';
import { EffortSelector } from '../EffortSelector';
import type { ModelConfig } from '../ModelSelector';
import { ModelSelector } from '../ModelSelector';
import { PermissionModeSelector } from '../PermissionModeSelector';
import { TimerPill } from '../Pill';
import { getModelDisplayName } from '../Pill/modelDisplay';
import { SessionIdsList } from '../SessionIds';
import { Tag } from '../Tag';
import { SessionMcpFooterControl } from './SessionMcpFooterControl';

export interface SessionFooterProps {
  // Session data for chips
  session: Session;
  footerTimerTask: Task | null;
  tokenBreakdown: {
    total: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    cost: number;
  };
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
  hasInput: boolean;
  composerAttachmentsPresent?: boolean;
  composerAttachmentUploading?: boolean;
  connectionDisabled: boolean;
  toolCaps?: { supportsSessionFork?: boolean; supportsChildSpawn?: boolean };
  // Settings state
  effortLevel: EffortLevel;
  permissionMode: PermissionMode;
  codexSandboxMode: CodexSandboxMode;
  codexApprovalPolicy: CodexApprovalPolicy;
  queuedTasks: Task[];
  client: AgorClient | null;
  modelLabel?: string;
  modelConfig?: ModelConfig;
  // Handlers
  onModelConfigChange: (config: ModelConfig) => void;
  onOpenSessionSettings?: (sessionId: string) => void;
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
  // Prompt textarea rendered between the two bars
  promptInputSlot: React.ReactNode;
}

// Memoized: the panel re-renders once per animation frame while its session
// streams (reactive-session notifies), and this footer is a large subtree of
// dropdowns/popovers that doesn't depend on per-chunk state. SessionPanel
// keeps every prop identity-stable across those renders (stable handler
// wrappers, memoized slot/config objects) so the bailout actually holds.
const SessionFooterInner: React.FC<SessionFooterProps> = ({
  session,
  footerTimerTask,
  tokenBreakdown,
  latestContextWindow,
  footerGradient,
  sessionMcpServerIds,
  unauthedMcpServers,
  mcpServerById,
  userAuthenticatedMcpServerIds,
  isRunning,
  isStopping,
  stopRequestInFlight,
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
  onModelConfigChange,
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
  const { token } = theme.useToken();
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [prefs, setPref] = useFooterPreferences();
  const pinnedItems = prefs.pinnedItems;
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

  // Model name + token counts for individual chips
  const modelName = session.model_config?.model
    ? getModelDisplayName(
        session.model_config.provider
          ? `${session.model_config.provider}/${session.model_config.model}`
          : session.model_config.model
      )
    : null;
  const tokenDisplay =
    tokenBreakdown.total >= 1000
      ? `${Math.round(tokenBreakdown.total / 1000)}k`
      : tokenBreakdown.total > 0
        ? String(tokenBreakdown.total)
        : null;

  // Context window usage percentage (for warning styling).
  // Prefers the executor-supplied snapshot.percentage (0-100) when available
  // so Codex baseline-adjusted display matches the agent's own indicator.
  const contextPct = React.useMemo(() => {
    if (!latestContextWindow) return 0;
    const meta = latestContextWindow.taskMetadata as {
      normalized_sdk_response?: {
        contextUsageSnapshot?: { percentage: number; totalTokens: number; maxTokens: number };
      };
    } | null;
    const snapshot = meta?.normalized_sdk_response?.contextUsageSnapshot;
    return (
      resolveContextWindowPercentage(
        latestContextWindow.used,
        latestContextWindow.limit,
        snapshot
      ) / 100
    );
  }, [latestContextWindow]);
  const contextWarning = contextPct > 0.8;
  const composerAttachmentActionTooltip = 'Attachments are only supported for normal Send for now';
  const composerUploadTooltip = 'Uploading files...';
  const uploadDisabled = connectionDisabled || composerAttachmentUploading;
  const advancedUploadDisabled = uploadDisabled;
  const forkDisabled = connectionDisabled || composerAttachmentsPresent;
  const btwForkDisabled = connectionDisabled || !hasInput || composerAttachmentsPresent;
  const spawnDisabled = connectionDisabled || isRunning || composerAttachmentsPresent;
  const sendDisabled = connectionDisabled || composerAttachmentUploading || !hasInput;

  const sectionHeaderStyle: React.CSSProperties = {
    padding: '6px 12px 3px',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.4px',
    color: token.colorTextTertiary,
    userSelect: 'none' as const,
  };

  const overflowRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '0 6px 0 12px',
    height: 32,
  };

  const moreContent = (
    <fieldset
      aria-label="More options"
      style={{ width: 260, padding: '6px 0', margin: 0, border: 0 }}
    >
      {/* === Section: Settings === */}
      <div style={sectionHeaderStyle}>Settings</div>

      {/* Model */}
      <div
        style={{
          ...overflowRowStyle,
          height: 'auto',
          paddingTop: 6,
          paddingBottom: 6,
          alignItems: 'flex-start',
          cursor: 'default',
        }}
      >
        <RobotOutlined
          style={{ fontSize: 14, color: token.colorTextSecondary, flexShrink: 0, marginTop: 7 }}
        />
        <Typography.Text
          style={{
            fontSize: 12,
            color: token.colorTextSecondary,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
            marginTop: 7,
          }}
        >
          Model
        </Typography.Text>
        <div
          style={{
            maxWidth: 160,
            flexShrink: 0,
            pointerEvents: managedByPreset ? 'none' : undefined,
            opacity: managedByPreset ? 0.65 : undefined,
          }}
          title={
            managedByPreset ? 'Managed by preset; switch presets in Session Settings' : undefined
          }
        >
          <ModelSelector
            value={modelConfig}
            onChange={onModelConfigChange}
            agentic_tool={session.agentic_tool}
            client={client}
            compact
          />
        </div>
      </div>

      {/* Effort — only for claude-code */}
      {session.agentic_tool === 'claude-code' && (
        <div style={{ ...overflowRowStyle, cursor: 'default' }}>
          <PercentageOutlined
            style={{ fontSize: 14, color: token.colorTextSecondary, flexShrink: 0 }}
          />
          <Typography.Text
            style={{
              fontSize: 12,
              flex: 1,
              color: token.colorTextSecondary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            Effort
          </Typography.Text>
          <div
            style={{
              pointerEvents: managedByPreset ? 'none' : undefined,
              opacity: managedByPreset ? 0.65 : undefined,
            }}
          >
            <EffortSelector
              value={effortLevel}
              onChange={onEffortChange}
              size="small"
              compact
              plain
            />
          </div>
        </div>
      )}

      {/* Permissions */}
      <div style={{ ...overflowRowStyle, cursor: 'default' }}>
        <LockOutlined style={{ fontSize: 14, color: token.colorTextSecondary, flexShrink: 0 }} />
        <Typography.Text
          style={{
            fontSize: 12,
            flex: 1,
            color: token.colorTextSecondary,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
        >
          Permissions
        </Typography.Text>
        <div
          style={{
            pointerEvents: managedByPreset ? 'none' : undefined,
            opacity: managedByPreset ? 0.65 : undefined,
          }}
        >
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
            size="small"
          />
        </div>
      </div>

      <Divider style={{ margin: '4px 0' }} />

      {/* === Section: Actions === */}
      <div style={sectionHeaderStyle}>Actions</div>

      {/* Attach files */}
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
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
            }}
          >
            <PaperClipOutlined
              style={{ fontSize: 14, color: token.colorTextSecondary, flexShrink: 0 }}
            />
            <Typography.Text
              style={{
                fontSize: 13,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              Attach files
            </Typography.Text>
          </span>
        </Tooltip>
        <Tooltip
          title={pinnedItems.includes('upload') ? 'Unpin from bar' : 'Pin to bar'}
          placement="right"
        >
          <button
            type="button"
            aria-label={pinnedItems.includes('upload') ? 'Unpin Upload' : 'Pin Upload'}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: pinnedItems.includes('upload') ? token.colorPrimary : token.colorTextTertiary,
              lineHeight: 1,
              padding: '4px',
              flexShrink: 0,
              borderRadius: token.borderRadiusSM,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            onClick={(e) => {
              e.stopPropagation();
              togglePin('upload');
            }}
          >
            {pinnedItems.includes('upload') ? (
              <PushpinFilled style={{ fontSize: 12 }} />
            ) : (
              <PushpinOutlined style={{ fontSize: 12 }} />
            )}
          </button>
        </Tooltip>
      </div>

      {/* Advanced upload */}
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
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
            }}
          >
            <UploadOutlined
              style={{ fontSize: 14, color: token.colorTextSecondary, flexShrink: 0 }}
            />
            <Typography.Text
              style={{
                fontSize: 13,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              Advanced upload
            </Typography.Text>
          </span>
        </Tooltip>
        <Tooltip
          title={pinnedItems.includes('advanced-upload') ? 'Unpin from bar' : 'Pin to bar'}
          placement="right"
        >
          <button
            type="button"
            aria-label={
              pinnedItems.includes('advanced-upload')
                ? 'Unpin Advanced upload'
                : 'Pin Advanced upload'
            }
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: pinnedItems.includes('advanced-upload')
                ? token.colorPrimary
                : token.colorTextTertiary,
              lineHeight: 1,
              padding: '4px',
              flexShrink: 0,
              borderRadius: token.borderRadiusSM,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            onClick={(e) => {
              e.stopPropagation();
              togglePin('advanced-upload');
            }}
          >
            {pinnedItems.includes('advanced-upload') ? (
              <PushpinFilled style={{ fontSize: 12 }} />
            ) : (
              <PushpinOutlined style={{ fontSize: 12 }} />
            )}
          </button>
        </Tooltip>
      </div>

      {/* Fork */}
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
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
              }}
            >
              <ForkOutlined
                style={{ fontSize: 14, color: token.colorTextSecondary, flexShrink: 0 }}
              />
              <Typography.Text
                style={{
                  fontSize: 13,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                Fork session
              </Typography.Text>
            </span>
          </Tooltip>
          <Tooltip
            title={pinnedItems.includes('fork') ? 'Unpin from bar' : 'Pin to bar'}
            placement="right"
          >
            <button
              type="button"
              aria-label={pinnedItems.includes('fork') ? 'Unpin Fork' : 'Pin Fork'}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: pinnedItems.includes('fork') ? token.colorPrimary : token.colorTextTertiary,
                lineHeight: 1,
                padding: '4px',
                flexShrink: 0,
                borderRadius: token.borderRadiusSM,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onClick={(e) => {
                e.stopPropagation();
                togglePin('fork');
              }}
            >
              {pinnedItems.includes('fork') ? (
                <PushpinFilled style={{ fontSize: 12 }} />
              ) : (
                <PushpinOutlined style={{ fontSize: 12 }} />
              )}
            </button>
          </Tooltip>
        </div>
      )}

      {/* BTW fork */}
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
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
              }}
            >
              <QuestionCircleOutlined
                style={{ fontSize: 14, color: token.colorTextSecondary, flexShrink: 0 }}
              />
              <Typography.Text
                style={{
                  fontSize: 13,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                BTW fork
              </Typography.Text>
            </span>
          </Tooltip>
          <Tooltip
            title={pinnedItems.includes('btw-fork') ? 'Unpin from bar' : 'Pin to bar'}
            placement="right"
          >
            <button
              type="button"
              aria-label={pinnedItems.includes('btw-fork') ? 'Unpin BTW fork' : 'Pin BTW fork'}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: pinnedItems.includes('btw-fork')
                  ? token.colorPrimary
                  : token.colorTextTertiary,
                lineHeight: 1,
                padding: '4px',
                flexShrink: 0,
                borderRadius: token.borderRadiusSM,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onClick={(e) => {
                e.stopPropagation();
                togglePin('btw-fork');
              }}
            >
              {pinnedItems.includes('btw-fork') ? (
                <PushpinFilled style={{ fontSize: 12 }} />
              ) : (
                <PushpinOutlined style={{ fontSize: 12 }} />
              )}
            </button>
          </Tooltip>
        </div>
      )}

      {/* Spawn */}
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
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
              }}
            >
              <BranchesOutlined
                style={{ fontSize: 14, color: token.colorTextSecondary, flexShrink: 0 }}
              />
              <Typography.Text
                style={{
                  fontSize: 13,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                Spawn subsession
              </Typography.Text>
            </span>
          </Tooltip>
          <Tooltip
            title={pinnedItems.includes('spawn') ? 'Unpin from bar' : 'Pin to bar'}
            placement="right"
          >
            <button
              type="button"
              aria-label={pinnedItems.includes('spawn') ? 'Unpin Spawn' : 'Pin Spawn'}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: pinnedItems.includes('spawn') ? token.colorPrimary : token.colorTextTertiary,
                lineHeight: 1,
                padding: '4px',
                flexShrink: 0,
                borderRadius: token.borderRadiusSM,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onClick={(e) => {
                e.stopPropagation();
                togglePin('spawn');
              }}
            >
              {pinnedItems.includes('spawn') ? (
                <PushpinFilled style={{ fontSize: 12 }} />
              ) : (
                <PushpinOutlined style={{ fontSize: 12 }} />
              )}
            </button>
          </Tooltip>
        </div>
      )}

      <Divider style={{ margin: '4px 0' }} />

      {/* === Section: Info bar chips === */}
      <div style={sectionHeaderStyle}>Info bar</div>

      {footerTimerTask && (
        <div style={{ ...overflowRowStyle, cursor: 'default' }}>
          <ClockCircleOutlined
            style={{ fontSize: 14, color: token.colorTextSecondary, flexShrink: 0 }}
          />
          <Typography.Text
            style={{
              fontSize: 13,
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            Timer
          </Typography.Text>
          <Tooltip
            title={pinnedChips.includes('timer') ? 'Hide from info bar' : 'Show in info bar'}
            placement="right"
          >
            <button
              type="button"
              aria-label={pinnedChips.includes('timer') ? 'Hide timer' : 'Show timer'}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: pinnedChips.includes('timer') ? token.colorPrimary : token.colorTextTertiary,
                lineHeight: 1,
                padding: '4px',
                flexShrink: 0,
                borderRadius: token.borderRadiusSM,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onClick={() => toggleChip('timer')}
            >
              {pinnedChips.includes('timer') ? (
                <PushpinFilled style={{ fontSize: 12 }} />
              ) : (
                <PushpinOutlined style={{ fontSize: 12 }} />
              )}
            </button>
          </Tooltip>
        </div>
      )}

      <div style={{ ...overflowRowStyle, cursor: 'default' }}>
        <ToolOutlined style={{ fontSize: 14, color: token.colorTextSecondary, flexShrink: 0 }} />
        <Typography.Text
          style={{
            fontSize: 13,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
        >
          Tools
        </Typography.Text>
        <Tooltip
          title={pinnedChips.includes('tools') ? 'Hide from info bar' : 'Show in info bar'}
          placement="right"
        >
          <button
            type="button"
            aria-label={pinnedChips.includes('tools') ? 'Hide tools' : 'Show tools'}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: pinnedChips.includes('tools') ? token.colorPrimary : token.colorTextTertiary,
              lineHeight: 1,
              padding: '4px',
              flexShrink: 0,
              borderRadius: token.borderRadiusSM,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            onClick={() => toggleChip('tools')}
          >
            {pinnedChips.includes('tools') ? (
              <PushpinFilled style={{ fontSize: 12 }} />
            ) : (
              <PushpinOutlined style={{ fontSize: 12 }} />
            )}
          </button>
        </Tooltip>
      </div>

      {modelName && (
        <div style={{ ...overflowRowStyle, cursor: 'default' }}>
          <RobotOutlined style={{ fontSize: 14, color: token.colorTextSecondary, flexShrink: 0 }} />
          <Typography.Text
            style={{
              fontSize: 13,
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            Model
          </Typography.Text>
          <Tooltip
            title={pinnedChips.includes('model') ? 'Hide from info bar' : 'Show in info bar'}
            placement="right"
          >
            <button
              type="button"
              aria-label={pinnedChips.includes('model') ? 'Hide model' : 'Show model'}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: pinnedChips.includes('model') ? token.colorPrimary : token.colorTextTertiary,
                lineHeight: 1,
                padding: '4px',
                flexShrink: 0,
                borderRadius: token.borderRadiusSM,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onClick={() => toggleChip('model')}
            >
              {pinnedChips.includes('model') ? (
                <PushpinFilled style={{ fontSize: 12 }} />
              ) : (
                <PushpinOutlined style={{ fontSize: 12 }} />
              )}
            </button>
          </Tooltip>
        </div>
      )}

      {tokenDisplay !== null && (
        <div style={{ ...overflowRowStyle, cursor: 'default' }}>
          <NumberOutlined
            style={{ fontSize: 14, color: token.colorTextSecondary, flexShrink: 0 }}
          />
          <Typography.Text
            style={{
              fontSize: 13,
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            Tokens
          </Typography.Text>
          <Tooltip
            title={pinnedChips.includes('tokens') ? 'Hide from info bar' : 'Show in info bar'}
            placement="right"
          >
            <button
              type="button"
              aria-label={pinnedChips.includes('tokens') ? 'Hide tokens' : 'Show tokens'}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: pinnedChips.includes('tokens')
                  ? token.colorPrimary
                  : token.colorTextTertiary,
                lineHeight: 1,
                padding: '4px',
                flexShrink: 0,
                borderRadius: token.borderRadiusSM,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onClick={() => toggleChip('tokens')}
            >
              {pinnedChips.includes('tokens') ? (
                <PushpinFilled style={{ fontSize: 12 }} />
              ) : (
                <PushpinOutlined style={{ fontSize: 12 }} />
              )}
            </button>
          </Tooltip>
        </div>
      )}

      {latestContextWindow && latestContextWindow.limit > 0 && (
        <div style={{ ...overflowRowStyle, cursor: 'default' }}>
          <PercentageOutlined
            style={{ fontSize: 14, color: token.colorTextSecondary, flexShrink: 0 }}
          />
          <Typography.Text
            style={{
              fontSize: 13,
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            Context %
          </Typography.Text>
          <Tooltip
            title={pinnedChips.includes('context') ? 'Hide from info bar' : 'Show in info bar'}
            placement="right"
          >
            <button
              type="button"
              aria-label={pinnedChips.includes('context') ? 'Hide context' : 'Show context'}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: pinnedChips.includes('context')
                  ? token.colorPrimary
                  : token.colorTextTertiary,
                lineHeight: 1,
                padding: '4px',
                flexShrink: 0,
                borderRadius: token.borderRadiusSM,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onClick={() => toggleChip('context')}
            >
              {pinnedChips.includes('context') ? (
                <PushpinFilled style={{ fontSize: 12 }} />
              ) : (
                <PushpinOutlined style={{ fontSize: 12 }} />
              )}
            </button>
          </Tooltip>
        </div>
      )}

      <Divider style={{ margin: '4px 0' }} />

      {/* Session IDs row */}
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
          <IdcardOutlined
            style={{ fontSize: 14, color: token.colorTextSecondary, flexShrink: 0 }}
          />
          <Typography.Text
            style={{
              fontSize: 13,
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            Session IDs
          </Typography.Text>
          <Tooltip
            title={pinnedChips.includes('session-ids') ? 'Hide from info bar' : 'Show in info bar'}
            placement="right"
          >
            <button
              type="button"
              aria-label={
                pinnedChips.includes('session-ids') ? 'Unpin Session IDs' : 'Pin Session IDs'
              }
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: pinnedChips.includes('session-ids')
                  ? token.colorPrimary
                  : token.colorTextTertiary,
                lineHeight: 1,
                padding: '4px',
                flexShrink: 0,
                borderRadius: token.borderRadiusSM,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onClick={(e) => {
                e.stopPropagation();
                toggleChip('session-ids');
              }}
            >
              {pinnedChips.includes('session-ids') ? (
                <PushpinFilled style={{ fontSize: 12 }} />
              ) : (
                <PushpinOutlined style={{ fontSize: 12 }} />
              )}
            </button>
          </Tooltip>
        </div>
      </Popover>

      {onOpenSessionSettings && (
        <>
          <Divider style={{ margin: '4px 0' }} />
          <Button
            block
            type="text"
            icon={<SettingOutlined />}
            aria-label="Session settings"
            style={{
              height: 32,
              justifyContent: 'flex-start',
              paddingInline: 12,
              fontSize: 13,
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

  const stopTooltip = stopRequestInFlight
    ? 'Sending stop request...'
    : isStopping
      ? 'Stopping... (Click again to retry if stuck)'
      : 'Stop Execution';

  const showStop = isRunning || stopRequestInFlight;

  const sendLabel = isRunning && hasInput ? 'Queue' : 'Send';
  const sendTooltip = connectionDisabled
    ? 'Disconnected from daemon'
    : composerAttachmentUploading
      ? composerUploadTooltip
      : isRunning
        ? 'Queue Message'
        : 'Send Prompt';

  return (
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

      <div style={{ position: 'relative', zIndex: 1 }}>
        {/* Row 1 — Info bar */}
        {(pinnedChips.includes('tools') ||
          (footerTimerTask && pinnedChips.includes('timer')) ||
          (modelName && pinnedChips.includes('model')) ||
          (tokenDisplay !== null && pinnedChips.includes('tokens')) ||
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
              flexWrap: 'wrap',
            }}
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

            {pinnedChips.includes('tools') && (
              <SessionMcpFooterControl
                client={client}
                sessionId={session.session_id}
                sessionMcpServerIds={sessionMcpServerIds}
                mcpServerById={mcpServerById}
                userAuthenticatedMcpServerIds={userAuthenticatedMcpServerIds}
              />
            )}

            {/* Model chip */}
            {modelName && pinnedChips.includes('model') && (
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
                        value={modelConfig}
                        onChange={onModelConfigChange}
                        agentic_tool={session.agentic_tool}
                        client={client}
                      />
                    )}
                  </div>
                }
              >
                <Tag
                  icon={<RobotOutlined />}
                  color="default"
                  style={{
                    cursor: managedByPreset ? 'default' : 'pointer',
                    height: 22,
                    display: 'inline-flex',
                    alignItems: 'center',
                    maxWidth: 180,
                  }}
                  data-testid="model-chip"
                >
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {modelName}
                  </span>
                </Tag>
              </Popover>
            )}

            {/* Tokens chip */}
            {tokenDisplay !== null && pinnedChips.includes('tokens') && (
              <Tooltip
                title={
                  tokenBreakdown.total > 0 ? (
                    <div style={{ fontSize: 12 }}>
                      <div>Total: {tokenBreakdown.total.toLocaleString()}</div>
                      {tokenBreakdown.input > 0 && (
                        <div>Input: {tokenBreakdown.input.toLocaleString()}</div>
                      )}
                      {tokenBreakdown.output > 0 && (
                        <div>Output: {tokenBreakdown.output.toLocaleString()}</div>
                      )}
                      {tokenBreakdown.cacheRead > 0 && (
                        <div>Cache read: {tokenBreakdown.cacheRead.toLocaleString()}</div>
                      )}
                      {tokenBreakdown.cost > 0 && (
                        <div>Est. cost: ${tokenBreakdown.cost.toFixed(4)}</div>
                      )}
                    </div>
                  ) : undefined
                }
                placement="top"
              >
                <Tag
                  color="default"
                  style={{
                    cursor: 'default',
                    height: 22,
                    display: 'inline-flex',
                    alignItems: 'center',
                  }}
                  data-testid="tokens-chip"
                >
                  {tokenDisplay} tokens
                </Tag>
              </Tooltip>
            )}

            {/* Context % chip */}
            {latestContextWindow &&
              latestContextWindow.limit > 0 &&
              pinnedChips.includes('context') && (
                <Tag
                  icon={
                    <PercentageOutlined
                      style={{ color: contextWarning ? token.colorWarning : undefined }}
                    />
                  }
                  color={contextWarning ? 'warning' : 'default'}
                  style={{
                    cursor: 'default',
                    height: 22,
                    display: 'inline-flex',
                    alignItems: 'center',
                  }}
                  data-testid="context-chip"
                  data-warning={contextWarning ? 'true' : undefined}
                >
                  {Math.round(contextPct * 100)}%
                </Tag>
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

        {/* Row 2 — Prompt textarea */}
        {promptInputSlot}

        {/* Row 3 — Action bar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: token.sizeUnit,
            marginTop: token.sizeUnit * 2,
          }}
        >
          {/* Left group */}
          <Space size={4}>
            {pinnedItems.includes('upload') && (
              <Tooltip
                title={
                  composerAttachmentUploading
                    ? composerUploadTooltip
                    : connectionDisabled
                      ? 'Disconnected from daemon'
                      : 'Attach Files'
                }
              >
                <Button
                  size="small"
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
            {pinnedItems.includes('advanced-upload') && (
              <Tooltip
                title={
                  composerAttachmentUploading
                    ? composerUploadTooltip
                    : connectionDisabled
                      ? 'Disconnected from daemon'
                      : 'Advanced upload'
                }
              >
                <Button
                  size="small"
                  type="text"
                  aria-label="Advanced upload"
                  title="Advanced upload"
                  icon={<UploadOutlined />}
                  onClick={onUploadOpen}
                  disabled={advancedUploadDisabled}
                />
              </Tooltip>
            )}
            {pinnedItems.includes('fork') && toolCaps?.supportsSessionFork !== false && (
              <Tooltip title={connectionDisabled ? 'Disconnected from daemon' : 'Fork Session'}>
                <Button
                  size="small"
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
            {pinnedItems.includes('btw-fork') && toolCaps?.supportsSessionFork !== false && (
              <Tooltip title="BTW fork">
                <Button
                  size="small"
                  type="text"
                  aria-label="Ask side question via BTW fork"
                  icon={<QuestionCircleOutlined />}
                  onClick={onBtwSend}
                  disabled={btwForkDisabled}
                  data-testid="btw-fork-bar-btn"
                />
              </Tooltip>
            )}
            {pinnedItems.includes('spawn') && toolCaps?.supportsChildSpawn !== false && (
              <Tooltip title="Spawn subsession">
                <Button
                  size="small"
                  type="text"
                  aria-label="Spawn subsession"
                  icon={<BranchesOutlined />}
                  onClick={onSpawnOpen}
                  disabled={spawnDisabled}
                />
              </Tooltip>
            )}
            <Popover
              open={moreOpen}
              onOpenChange={setMoreOpen}
              trigger="click"
              placement="topLeft"
              content={moreContent}
              title={null}
            >
              <Tooltip title="More options">
                <Button
                  size="small"
                  type="text"
                  icon={<EllipsisOutlined />}
                  aria-label="More options"
                />
              </Tooltip>
            </Popover>
          </Space>

          {/* Spacer */}
          <div style={{ flex: 1 }} />

          {/* Right group */}
          <Space size={4}>
            {showStop && (
              <Tooltip title={stopTooltip}>
                <Button
                  danger
                  size="small"
                  icon={
                    isStopping && !stopRequestInFlight ? <Spin size="small" /> : <StopOutlined />
                  }
                  onClick={onStop}
                  disabled={!isRunning || stopRequestInFlight}
                >
                  Stop
                </Button>
              </Tooltip>
            )}
            <Tooltip title={sendTooltip}>
              <Badge
                count={queuedTasks.length > 0 ? queuedTasks.length : 0}
                size="small"
                offset={[-2, 2]}
                style={{
                  boxShadow: 'none',
                  backgroundColor: token.colorTextTertiary,
                  fontSize: 10,
                }}
              >
                <Button
                  type="primary"
                  size="small"
                  icon={<SendOutlined />}
                  onClick={onSendPrompt}
                  disabled={sendDisabled}
                >
                  {sendLabel}
                </Button>
              </Badge>
            </Tooltip>
          </Space>
        </div>
      </div>
    </div>
  );
};

export const SessionFooter = React.memo(SessionFooterInner);
SessionFooter.displayName = 'SessionFooter';
