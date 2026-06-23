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
  DollarOutlined,
  EllipsisOutlined,
  ForkOutlined,
  PaperClipOutlined,
  PercentageOutlined,
  QuestionCircleOutlined,
  RobotOutlined,
  SendOutlined,
  StopOutlined,
  ToolOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Button, Divider, Popover, Space, Spin, Tooltip, Typography, theme } from 'antd';
import React from 'react';
import { EffortSelector } from '../EffortSelector';
import type { ModelConfig } from '../ModelSelector';
import { ModelSelector } from '../ModelSelector';
import { PermissionModeSelector } from '../PermissionModeSelector';
import { TimerPill } from '../Pill';
import { getModelDisplayName } from '../Pill/modelDisplay';
import { SessionIdsButton } from '../SessionIds';
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

  // Stats chip: show when model or tokens are present
  const modelName = session.model_config?.model
    ? getModelDisplayName(
        session.model_config.provider
          ? `${session.model_config.provider}/${session.model_config.model}`
          : session.model_config.model
      )
    : null;
  const tokensK = tokenBreakdown.total > 0 ? Math.round(tokenBreakdown.total / 1000) : 0;
  const showStatsChip = !!(modelName || tokenBreakdown.total > 0);

  // Context window usage percentage (for warning styling)
  const contextPct =
    latestContextWindow && latestContextWindow.limit > 0
      ? latestContextWindow.used / latestContextWindow.limit
      : 0;
  const contextWarning = contextPct > 0.8;

  // Tools chip: show when MCP servers are attached
  const showToolsChip = sessionMcpServerIds.length > 0;
  const hasUnauthedMcp = unauthedMcpServers.length > 0;

  // Tools chip popover: list server names
  const toolsPopoverContent = (
    <div style={{ maxWidth: 280 }}>
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <Typography.Text strong style={{ fontSize: 13 }}>
          Attached MCP servers
        </Typography.Text>
        {sessionMcpServerIds.map((id) => {
          const server = mcpServerById.get(id);
          const needsAuth = unauthedMcpServers.some((s) => s.mcp_server_id === id);
          return (
            <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {needsAuth && <WarningOutlined style={{ color: token.colorWarning, fontSize: 12 }} />}
              <Typography.Text style={{ fontSize: 12 }}>
                {server?.name ?? id}
                {needsAuth && (
                  <Typography.Text type="warning" style={{ fontSize: 11, marginLeft: 4 }}>
                    (needs auth)
                  </Typography.Text>
                )}
              </Typography.Text>
            </div>
          );
        })}
        {onOpenSessionSettings && (
          <>
            <Divider style={{ margin: '4px 0' }} />
            <Button
              type="link"
              size="small"
              style={{ padding: 0, height: 'auto' }}
              onClick={() => onOpenSessionSettings(session.session_id)}
            >
              MCP settings
            </Button>
          </>
        )}
      </Space>
    </div>
  );

  // Stats chip popover: model, tokens, context window, cost, effort, timer
  const statsPopoverContent = (
    <div style={{ width: 260 }}>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {modelName && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Space size={4}>
              <RobotOutlined style={{ fontSize: 12, color: token.colorTextSecondary }} />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Model
              </Typography.Text>
            </Space>
            <Typography.Text style={{ fontSize: 12 }}>{modelName}</Typography.Text>
          </div>
        )}
        {tokenBreakdown.total > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Tokens
            </Typography.Text>
            <Typography.Text style={{ fontSize: 12 }}>
              {tokenBreakdown.total.toLocaleString()}
            </Typography.Text>
          </div>
        )}
        {latestContextWindow && latestContextWindow.limit > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Space size={4}>
              <PercentageOutlined
                style={{
                  fontSize: 12,
                  color: contextWarning ? token.colorWarning : token.colorTextSecondary,
                }}
              />
              <Typography.Text
                type={contextWarning ? 'warning' : 'secondary'}
                style={{ fontSize: 12 }}
              >
                Context
              </Typography.Text>
            </Space>
            <Typography.Text type={contextWarning ? 'warning' : undefined} style={{ fontSize: 12 }}>
              {Math.round(contextPct * 100)}%
            </Typography.Text>
          </div>
        )}
        {tokenBreakdown.cost > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Space size={4}>
              <DollarOutlined style={{ fontSize: 12, color: token.colorTextSecondary }} />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Est. cost
              </Typography.Text>
            </Space>
            <Typography.Text style={{ fontSize: 12 }}>
              ${tokenBreakdown.cost.toFixed(4)}
            </Typography.Text>
          </div>
        )}
        {effortLevel && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Effort
            </Typography.Text>
            <Typography.Text style={{ fontSize: 12, textTransform: 'capitalize' }}>
              {effortLevel}
            </Typography.Text>
          </div>
        )}
        {footerTimerTask && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Space size={4}>
              <ClockCircleOutlined style={{ fontSize: 12, color: token.colorTextSecondary }} />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Elapsed
              </Typography.Text>
            </Space>
            <TimerPill
              status={footerTimerTask.status}
              startedAt={
                footerTimerTask.message_range?.start_timestamp || footerTimerTask.created_at
              }
              endedAt={footerTimerTask.message_range?.end_timestamp || footerTimerTask.completed_at}
              durationMs={footerTimerTask.duration_ms}
              lastExecutorHeartbeatAt={footerTimerTask.last_executor_heartbeat_at}
            />
          </div>
        )}
      </Space>
    </div>
  );

  // ··· more panel content (Popover with settings + overflow actions)
  const moreContent = (
    <div style={{ width: 280 }}>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {/* Overflow actions */}
        {(toolCaps?.supportsSessionFork !== false || toolCaps?.supportsChildSpawn !== false) && (
          <>
            <Space size={4} wrap>
              {toolCaps?.supportsSessionFork !== false && (
                <Tooltip title="Ask a side question via ephemeral BTW fork">
                  <Button
                    size="small"
                    type="default"
                    icon={<QuestionCircleOutlined />}
                    disabled={connectionDisabled || !hasInput}
                    onClick={() => {
                      setMoreOpen(false);
                      onBtwSend();
                    }}
                  >
                    BTW fork
                  </Button>
                </Tooltip>
              )}
              {toolCaps?.supportsChildSpawn !== false && (
                <Tooltip
                  title={
                    connectionDisabled
                      ? 'Disconnected from daemon'
                      : isRunning
                        ? 'Session is running'
                        : 'Spawn subsession'
                  }
                >
                  <Button
                    size="small"
                    type="default"
                    icon={<BranchesOutlined />}
                    disabled={connectionDisabled || isRunning}
                    onClick={() => {
                      setMoreOpen(false);
                      onSpawnOpen();
                    }}
                  >
                    Spawn
                  </Button>
                </Tooltip>
              )}
            </Space>
            <Divider style={{ margin: '4px 0' }} />
          </>
        )}

        {/* Model selector */}
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Model
          </Typography.Text>
          <div style={{ marginTop: token.sizeUnit }}>
            <ModelSelector
              value={modelConfig}
              onChange={onModelConfigChange}
              agentic_tool={session.agentic_tool}
              client={client}
              compact
            />
          </div>
        </div>

        {/* Effort selector — only for claude-code */}
        {session.agentic_tool === 'claude-code' && (
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Reasoning effort
            </Typography.Text>
            <div style={{ marginTop: token.sizeUnit }}>
              <EffortSelector
                value={effortLevel}
                onChange={onEffortChange}
                size="small"
                compact
                plain
                fullWidth
              />
            </div>
          </div>
        )}

        {/* Permission mode */}
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Permissions
          </Typography.Text>
          <div style={{ marginTop: token.sizeUnit }}>
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
              fullWidth
              size="small"
            />
          </div>
        </div>

        <Divider style={{ margin: '4px 0' }} />

        {/* Session IDs */}
        <SessionIdsButton session={session} />
      </Space>
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
        {(showToolsChip || showStatsChip) && (
          <div
            style={{
              display: 'flex',
              gap: token.sizeUnit,
              alignItems: 'center',
              marginBottom: token.sizeUnit * 2,
              flexWrap: 'wrap',
            }}
          >
            {showToolsChip && (
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
                  }}
                  data-testid="tools-chip"
                >
                  Tools&nbsp;·&nbsp;{sessionMcpServerIds.length}
                  {hasUnauthedMcp && (
                    <WarningOutlined
                      style={{ marginLeft: token.sizeUnit, color: token.colorWarning }}
                    />
                  )}
                </Tag>
              </Popover>
            )}

            {showStatsChip && (
              <Popover
                trigger="click"
                placement="topLeft"
                content={statsPopoverContent}
                title={null}
              >
                <Tag
                  icon={<RobotOutlined />}
                  color={contextWarning ? 'warning' : 'default'}
                  style={{
                    cursor: 'pointer',
                    height: 22,
                    display: 'inline-flex',
                    alignItems: 'center',
                  }}
                  data-testid="stats-chip"
                  data-warning={contextWarning ? 'true' : undefined}
                >
                  {modelName && <span>{modelName}</span>}
                  {modelName && tokensK > 0 && <span>&nbsp;·&nbsp;</span>}
                  {tokensK > 0 && <span>{tokensK}k</span>}
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
            <Tooltip title={connectionDisabled ? 'Disconnected from daemon' : 'Upload Files'}>
              <Button
                size="small"
                type="text"
                icon={<PaperClipOutlined />}
                onClick={onUploadOpen}
                disabled={connectionDisabled}
              />
            </Tooltip>
            {toolCaps?.supportsSessionFork !== false && (
              <Tooltip title={connectionDisabled ? 'Disconnected from daemon' : 'Fork Session'}>
                <Button
                  size="small"
                  type="text"
                  icon={<ForkOutlined />}
                  onClick={onFork}
                  disabled={connectionDisabled}
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
              <Button
                type="primary"
                size="small"
                icon={<SendOutlined />}
                onClick={onSendPrompt}
                disabled={connectionDisabled || !hasInput}
              >
                {sendLabel}
              </Button>
            </Tooltip>
          </Space>
        </div>
      </div>
    </div>
  );
};
