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
  CheckCircleFilled,
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
  WarningOutlined,
} from '@ant-design/icons';
import { Badge, Button, Divider, Popover, Space, Spin, Tooltip, Typography, theme } from 'antd';
import React from 'react';
import { useFooterPreferences } from '../../hooks/useFooterPreferences';
import { EffortSelector } from '../EffortSelector';
import type { ModelConfig } from '../ModelSelector';
import { ModelSelector } from '../ModelSelector';
import { PermissionModeSelector } from '../PermissionModeSelector';
import { TimerPill } from '../Pill';
import { getModelDisplayName } from '../Pill/modelDisplay';
import { SessionIdsList } from '../SessionIds';
import { Tag } from '../Tag';

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
  // Action state
  isRunning: boolean;
  isStopping: boolean;
  stopRequestInFlight: boolean;
  hasInput: boolean;
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
  onUploadOpen: () => void;
  onEffortChange: (v: EffortLevel) => void;
  onPermissionModeChange: (v: PermissionMode) => void;
  onCodexPermissionChange: (sandbox: CodexSandboxMode, approval: CodexApprovalPolicy) => void;
  // Prompt textarea rendered between the two bars
  promptInputSlot: React.ReactNode;
}

export const SessionFooter: React.FC<SessionFooterProps> = ({
  session,
  footerTimerTask,
  tokenBreakdown,
  latestContextWindow,
  footerGradient,
  sessionMcpServerIds,
  unauthedMcpServers,
  mcpServerById,
  isRunning,
  isStopping,
  stopRequestInFlight,
  hasInput,
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
  onUploadOpen,
  onEffortChange,
  onPermissionModeChange,
  onCodexPermissionChange,
  promptInputSlot,
}) => {
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
  const tokensK = tokenBreakdown.total > 0 ? Math.round(tokenBreakdown.total / 1000) : 0;

  // Context window usage percentage (for warning styling)
  const contextPct =
    latestContextWindow && latestContextWindow.limit > 0
      ? latestContextWindow.used / latestContextWindow.limit
      : 0;
  const contextWarning = contextPct > 0.8;

  const hasUnauthedMcp = unauthedMcpServers.length > 0;

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

  // Tools chip popover: list server names
  const toolsPopoverContent = (
    <div style={{ width: 260, paddingTop: 6, paddingBottom: 6 }}>
      <div style={sectionHeaderStyle}>Tools</div>

      {sessionMcpServerIds.length === 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 4,
            padding: '12px 12px 8px',
            textAlign: 'center',
          }}
        >
          <ToolOutlined style={{ fontSize: 20, color: token.colorTextTertiary }} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            No tools attached
          </Typography.Text>
          <Typography.Text
            type="secondary"
            style={{ fontSize: 11, color: token.colorTextTertiary }}
          >
            Add MCP servers in settings
          </Typography.Text>
        </div>
      )}

      {sessionMcpServerIds.map((id) => {
        const server = mcpServerById.get(id);
        const needsAuth = unauthedMcpServers.some((s) => s.mcp_server_id === id);
        return (
          <div
            key={id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '0 12px',
              height: 32,
            }}
          >
            {needsAuth ? (
              <WarningOutlined style={{ fontSize: 12, color: token.colorWarning, flexShrink: 0 }} />
            ) : (
              <CheckCircleFilled
                style={{ fontSize: 12, color: token.colorSuccess, flexShrink: 0 }}
              />
            )}
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
              {server?.name ?? id}
            </Typography.Text>
            {needsAuth && (
              <Typography.Text
                type="warning"
                style={{ fontSize: 11, flexShrink: 0, whiteSpace: 'nowrap' }}
              >
                needs auth
              </Typography.Text>
            )}
          </div>
        );
      })}

      {onOpenSessionSettings && (
        <>
          <Divider style={{ margin: '4px 0' }} />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '0 6px 0 12px',
              height: 32,
              cursor: 'pointer',
            }}
            onClick={() => onOpenSessionSettings(session.session_id)}
          >
            <SettingOutlined
              style={{ fontSize: 14, color: token.colorTextSecondary, flexShrink: 0 }}
            />
            <Typography.Text style={{ fontSize: 13, flex: 1 }}>MCP settings</Typography.Text>
          </div>
        </>
      )}
    </div>
  );

  const moreContent = (
    <div style={{ width: 260, paddingTop: 6, paddingBottom: 6 }}>
      {/* === Section: Settings === */}
      <div style={sectionHeaderStyle}>Settings</div>

      {/* Model */}
      <div style={{ ...overflowRowStyle, alignItems: 'flex-start', cursor: 'default' }}>
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
        <div style={{ maxWidth: 160, flexShrink: 0 }}>
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
          <EffortSelector
            value={effortLevel}
            onChange={onEffortChange}
            size="small"
            compact
            plain
          />
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

      <Divider style={{ margin: '4px 0' }} />

      {/* === Section: Actions === */}
      <div style={sectionHeaderStyle}>Actions</div>

      {/* Upload */}
      <div
        style={{
          ...overflowRowStyle,
          opacity: connectionDisabled ? 0.4 : 1,
          cursor: connectionDisabled ? 'not-allowed' : 'pointer',
        }}
        onClick={
          connectionDisabled
            ? undefined
            : () => {
                setMoreOpen(false);
                onUploadOpen();
              }
        }
      >
        <Tooltip
          title={connectionDisabled ? 'Disconnected from daemon' : 'Attach files to prompt'}
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

      {/* Fork */}
      {toolCaps?.supportsSessionFork !== false && (
        <div
          style={{
            ...overflowRowStyle,
            opacity: connectionDisabled ? 0.4 : 1,
            cursor: connectionDisabled ? 'not-allowed' : 'pointer',
          }}
          onClick={
            connectionDisabled
              ? undefined
              : () => {
                  setMoreOpen(false);
                  onFork();
                }
          }
        >
          <Tooltip
            title={connectionDisabled ? 'Disconnected from daemon' : 'Fork this session'}
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
        <div
          style={{
            ...overflowRowStyle,
            opacity: connectionDisabled || !hasInput ? 0.4 : 1,
            cursor: connectionDisabled || !hasInput ? 'not-allowed' : 'pointer',
          }}
          onClick={
            connectionDisabled || !hasInput
              ? undefined
              : () => {
                  setMoreOpen(false);
                  onBtwSend();
                }
          }
        >
          <Tooltip
            title={
              connectionDisabled || !hasInput
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
        <div
          style={{
            ...overflowRowStyle,
            opacity: connectionDisabled || isRunning ? 0.4 : 1,
            cursor: connectionDisabled || isRunning ? 'not-allowed' : 'pointer',
          }}
          onClick={
            connectionDisabled || isRunning
              ? undefined
              : () => {
                  setMoreOpen(false);
                  onSpawnOpen();
                }
          }
        >
          <Tooltip
            title={
              connectionDisabled
                ? 'Disconnected'
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

      {tokensK > 0 && (
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
        <div style={{ ...overflowRowStyle, cursor: 'pointer' }}>
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
    </div>
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
          (tokensK > 0 && pinnedChips.includes('tokens')) ||
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
                />
              </div>
            )}

            {pinnedChips.includes('tools') && (
              <Popover
                trigger="click"
                placement="topLeft"
                content={toolsPopoverContent}
                title={null}
              >
                <Tag
                  icon={<ToolOutlined />}
                  color={hasUnauthedMcp ? 'warning' : 'default'}
                  style={{
                    cursor: 'pointer',
                    height: 22,
                    display: 'inline-flex',
                    alignItems: 'center',
                    opacity: sessionMcpServerIds.length === 0 ? 0.45 : 1,
                  }}
                  data-testid="tools-chip"
                >
                  {sessionMcpServerIds.length === 0 ? (
                    'No tools'
                  ) : (
                    <>
                      Tools&nbsp;·&nbsp;{sessionMcpServerIds.length}
                      {hasUnauthedMcp && (
                        <WarningOutlined
                          style={{ marginLeft: token.sizeUnit, color: token.colorWarning }}
                        />
                      )}
                    </>
                  )}
                </Tag>
              </Popover>
            )}

            {/* Model chip */}
            {modelName && pinnedChips.includes('model') && (
              <Popover
                trigger="click"
                placement="topLeft"
                title="Model"
                overlayStyle={{ maxWidth: 'none' }}
                overlayInnerStyle={{ padding: 8 }}
                content={
                  <div style={{ width: 420 }}>
                    <ModelSelector
                      value={modelConfig}
                      onChange={onModelConfigChange}
                      agentic_tool={session.agentic_tool}
                      client={client}
                    />
                  </div>
                }
              >
                <Tag
                  icon={<RobotOutlined />}
                  color="default"
                  style={{
                    cursor: 'pointer',
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
            {tokensK > 0 && pinnedChips.includes('tokens') && (
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
                {tokensK}k tokens
              </Tag>
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
              <Tooltip title={connectionDisabled ? 'Disconnected from daemon' : 'Upload Files'}>
                <Button
                  size="small"
                  type="text"
                  icon={<PaperClipOutlined />}
                  onClick={onUploadOpen}
                  disabled={connectionDisabled}
                  data-testid="upload-bar-btn"
                />
              </Tooltip>
            )}
            {pinnedItems.includes('fork') && toolCaps?.supportsSessionFork !== false && (
              <Tooltip title={connectionDisabled ? 'Disconnected from daemon' : 'Fork Session'}>
                <Button
                  size="small"
                  type="text"
                  icon={<ForkOutlined />}
                  onClick={onFork}
                  disabled={connectionDisabled}
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
                  icon={<QuestionCircleOutlined />}
                  onClick={onBtwSend}
                  disabled={connectionDisabled || !hasInput}
                  data-testid="btw-fork-bar-btn"
                />
              </Tooltip>
            )}
            {pinnedItems.includes('spawn') && toolCaps?.supportsChildSpawn !== false && (
              <Tooltip title="Spawn subsession">
                <Button
                  size="small"
                  type="text"
                  icon={<BranchesOutlined />}
                  onClick={onSpawnOpen}
                  disabled={connectionDisabled || isRunning}
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
                <Button size="small" type="text" icon={<EllipsisOutlined />} />
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
                style={{ boxShadow: 'none' }}
              >
                <Button
                  type="primary"
                  size="small"
                  icon={<SendOutlined />}
                  onClick={onSendPrompt}
                  disabled={connectionDisabled || !hasInput}
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
