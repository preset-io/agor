/**
 * Environment Tab - Two-level UI for environment management
 *
 * 1. Repository Template (top) - Editable commands that affect all worktrees
 * 2. Worktree Instance (bottom) - This worktree's variables and preview
 */

import type { AgorClient } from '@agor/core/api';
import { renderTemplate } from '@agor/core/templates/handlebars-helpers';
import type { Repo, RepoEnvironmentConfig, Worktree } from '@agor/core/types';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  CodeOutlined,
  EditOutlined,
  LoadingOutlined,
  PlayCircleOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  SaveOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Badge,
  Button,
  Card,
  Descriptions,
  Divider,
  Input,
  message,
  Space,
  Spin,
  Tag,
  Typography,
  theme,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';

const { Text, Paragraph, Title } = Typography;
const { TextArea } = Input;

interface EnvironmentTabProps {
  worktree: Worktree;
  repo: Repo;
  client: AgorClient | null;
  onUpdateRepo?: (repoId: string, updates: Partial<Repo>) => void;
  onUpdateWorktree?: (worktreeId: string, updates: Partial<Worktree>) => void;
}

export const EnvironmentTab: React.FC<EnvironmentTabProps> = ({
  worktree,
  repo,
  client,
  onUpdateRepo,
  onUpdateWorktree,
}) => {
  const { token } = theme.useToken();
  const hasEnvironmentConfig = !!repo.environment_config;

  // Repository template state (editable)
  const [isEditingTemplate, setIsEditingTemplate] = useState(false);
  const [upCommand, setUpCommand] = useState(repo.environment_config?.up_command || '');
  const [downCommand, setDownCommand] = useState(repo.environment_config?.down_command || '');
  const [healthCheckUrl, setHealthCheckUrl] = useState(
    repo.environment_config?.health_check?.url_template || ''
  );

  // Custom context state (editable)
  const [isEditingContext, setIsEditingContext] = useState(false);
  const [customContextJson, setCustomContextJson] = useState(
    JSON.stringify(worktree.custom_context || {}, null, 2)
  );

  // Environment control state
  const [envStatus, setEnvStatus] = useState(worktree.environment_instance?.status || 'stopped');
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isCheckingHealth, setIsCheckingHealth] = useState(false);
  const [lastHealthCheck, setLastHealthCheck] = useState(
    worktree.environment_instance?.last_health_check
  );
  const [processInfo, setProcessInfo] = useState(worktree.environment_instance?.process);

  // Sync state when worktree prop changes
  useEffect(() => {
    setEnvStatus(worktree.environment_instance?.status || 'stopped');
    const newHealthCheck = worktree.environment_instance?.last_health_check;

    // If health check timestamp changed, show checking state briefly
    if (newHealthCheck?.timestamp !== lastHealthCheck?.timestamp) {
      setIsCheckingHealth(true);
      setTimeout(() => setIsCheckingHealth(false), 500);
    }

    setLastHealthCheck(newHealthCheck);
    setProcessInfo(worktree.environment_instance?.process);
  }, [worktree, lastHealthCheck?.timestamp]);

  // WebSocket listener for real-time environment updates
  useEffect(() => {
    if (!client) return;

    const handleWorktreeUpdate = (updatedWorktree: Worktree) => {
      console.log(
        '🔄 WebSocket worktree update:',
        updatedWorktree.worktree_id.substring(0, 8),
        updatedWorktree.environment_instance
      );
      if (updatedWorktree.worktree_id === worktree.worktree_id) {
        console.log('✅ Updating UI state for worktree:', worktree.name);
        setEnvStatus(updatedWorktree.environment_instance?.status || 'stopped');
        setLastHealthCheck(updatedWorktree.environment_instance?.last_health_check);
        setProcessInfo(updatedWorktree.environment_instance?.process);
      }
    };

    client.service('worktrees').on('patched', handleWorktreeUpdate);
    return () => client.service('worktrees').off('patched', handleWorktreeUpdate);
  }, [client, worktree.worktree_id, worktree.name]);

  // Environment control handlers
  const handleStart = async () => {
    if (!client) return;
    setIsStarting(true);
    try {
      await client.service(`worktrees/${worktree.worktree_id}/start`).create({});
      message.success('Environment started successfully');
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Failed to start environment');
    } finally {
      setIsStarting(false);
    }
  };

  const handleStop = async () => {
    if (!client) return;
    setIsStopping(true);
    try {
      await client.service(`worktrees/${worktree.worktree_id}/stop`).create({});
      message.success('Environment stopped successfully');
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Failed to stop environment');
    } finally {
      setIsStopping(false);
    }
  };

  const handleRestart = async () => {
    if (!client) return;
    setIsRestarting(true);
    try {
      await client.service(`worktrees/${worktree.worktree_id}/restart`).create({});
      message.success('Environment restarted successfully');
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Failed to restart environment');
    } finally {
      setIsRestarting(false);
    }
  };

  // Check if template has unsaved changes
  const hasTemplateChanges = useMemo(() => {
    if (!repo.environment_config) return upCommand || downCommand || healthCheckUrl;
    return (
      upCommand !== repo.environment_config.up_command ||
      downCommand !== repo.environment_config.down_command ||
      healthCheckUrl !== (repo.environment_config.health_check?.url_template || '')
    );
  }, [upCommand, downCommand, healthCheckUrl, repo.environment_config]);

  // Build template context for preview
  const templateContext = useMemo(() => {
    let customContext = {};
    try {
      customContext = JSON.parse(customContextJson);
    } catch {
      // Invalid JSON, use empty object
    }

    return {
      worktree: {
        unique_id: worktree.worktree_unique_id,
        name: worktree.name,
        path: worktree.path,
      },
      repo: {
        slug: repo.slug,
      },
      custom: customContext,
    };
  }, [worktree, repo, customContextJson]);

  // Render template with current context
  const renderPreview = (template: string): { success: boolean; result: string } => {
    try {
      const result = renderTemplate(template, templateContext);
      return { success: true, result };
    } catch (error) {
      return {
        success: false,
        result: error instanceof Error ? error.message : 'Template error',
      };
    }
  };

  const handleSaveTemplate = () => {
    if (!onUpdateRepo) return;

    const newConfig: RepoEnvironmentConfig = {
      up_command: upCommand,
      down_command: downCommand,
      health_check: healthCheckUrl
        ? {
            type: 'http',
            url_template: healthCheckUrl,
          }
        : undefined,
    };

    onUpdateRepo(repo.repo_id, {
      environment_config: newConfig,
    });

    setIsEditingTemplate(false);
  };

  const handleSaveContext = () => {
    if (!onUpdateWorktree) return;

    try {
      const parsed = JSON.parse(customContextJson);
      onUpdateWorktree(worktree.worktree_id, {
        custom_context: parsed,
      });
      setIsEditingContext(false);
    } catch (error) {
      // TODO: Show error toast
      console.error('Invalid JSON:', error);
    }
  };

  const handleCancelTemplate = () => {
    setUpCommand(repo.environment_config?.up_command || '');
    setDownCommand(repo.environment_config?.down_command || '');
    setHealthCheckUrl(repo.environment_config?.health_check?.url_template || '');
    setIsEditingTemplate(false);
  };

  const handleCancelContext = () => {
    setCustomContextJson(JSON.stringify(worktree.custom_context || {}, null, 2));
    setIsEditingContext(false);
  };

  // Auto-enable editing if no config exists
  if (!hasEnvironmentConfig && !isEditingTemplate) {
    // Automatically show the form in edit mode
    setTimeout(() => setIsEditingTemplate(true), 0);
  }

  const upPreview = renderPreview(upCommand);
  const downPreview = renderPreview(downCommand);
  const healthPreview = healthCheckUrl ? renderPreview(healthCheckUrl) : null;

  // Helper to get status badge
  const getStatusBadge = () => {
    switch (envStatus) {
      case 'running':
        return <Badge status="processing" text="Running" />;
      case 'starting':
        return <Badge status="processing" text="Starting..." />;
      case 'stopping':
        return <Badge status="warning" text="Stopping..." />;
      case 'error':
        return <Badge status="error" text="Error" />;
      case 'stopped':
      default:
        return <Badge status="default" text="Stopped" />;
    }
  };

  // Helper to get health badge
  const getHealthBadge = () => {
    if (!lastHealthCheck) return null;

    switch (lastHealthCheck.status) {
      case 'healthy':
        return <CheckCircleOutlined style={{ color: token.colorSuccess }} />;
      case 'unhealthy':
        return <CloseCircleOutlined style={{ color: token.colorError }} />;
      default:
        return <WarningOutlined style={{ color: token.colorWarning }} />;
    }
  };

  // Format timestamp
  const formatTimestamp = (timestamp?: string) => {
    if (!timestamp) return 'Never';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);

    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    return date.toLocaleTimeString();
  };

  // Calculate uptime
  const getUptime = () => {
    if (!processInfo?.started_at) return null;
    const start = new Date(processInfo.started_at);
    const now = new Date();
    const diffMs = now.getTime() - start.getTime();
    const diffSec = Math.floor(diffMs / 1000);

    const hours = Math.floor(diffSec / 3600);
    const minutes = Math.floor((diffSec % 3600) / 60);
    const seconds = diffSec % 60;

    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  };

  return (
    <div style={{ width: '100%', padding: '0 24px', maxHeight: '70vh', overflowY: 'auto' }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        {/* ========== REPOSITORY TEMPLATE (Top Level) ========== */}
        <Card
          title={
            <Space>
              <CodeOutlined />
              <span>Repository Environment Template</span>
              <Tag color="orange" style={{ fontSize: 10 }}>
                Affects all worktrees on this repository
              </Tag>
            </Space>
          }
          size="small"
          extra={
            !isEditingTemplate && (
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                onClick={() => setIsEditingTemplate(true)}
              >
                Edit
              </Button>
            )
          }
        >
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {/* Up Command */}
            <div>
              <Text strong style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                Up Command (Start Environment)
              </Text>
              {isEditingTemplate ? (
                <>
                  <TextArea
                    value={upCommand}
                    onChange={e => setUpCommand(e.target.value)}
                    placeholder="DAEMON_PORT={{add 3000 worktree.unique_id}} UI_PORT={{add 5000 worktree.unique_id}} docker compose -p {{worktree.name}} up -d"
                    rows={3}
                    style={{ fontFamily: 'monospace', fontSize: 11 }}
                  />
                  <Text type="secondary" style={{ fontSize: 10, display: 'block', marginTop: 4 }}>
                    ⚠️ Command should start services in the background and return (e.g., docker
                    compose up -d, systemctl start, etc.)
                  </Text>
                </>
              ) : (
                <Text
                  code
                  style={{ fontSize: 11, wordBreak: 'break-all', display: 'block', padding: 8 }}
                >
                  {upCommand || <Text type="secondary">Not configured</Text>}
                </Text>
              )}
            </div>

            {/* Down Command */}
            <div>
              <Text strong style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                Down Command (Stop Environment)
              </Text>
              {isEditingTemplate ? (
                <>
                  <TextArea
                    value={downCommand}
                    onChange={e => setDownCommand(e.target.value)}
                    placeholder="docker compose -p {{worktree.name}} down"
                    rows={2}
                    style={{ fontFamily: 'monospace', fontSize: 11 }}
                  />
                  <Text type="secondary" style={{ fontSize: 10, display: 'block', marginTop: 4 }}>
                    Command should stop services and return (e.g., docker compose down, systemctl
                    stop, etc.)
                  </Text>
                </>
              ) : (
                <Text
                  code
                  style={{ fontSize: 11, wordBreak: 'break-all', display: 'block', padding: 8 }}
                >
                  {downCommand || <Text type="secondary">Not configured</Text>}
                </Text>
              )}
            </div>

            {/* Health Check URL */}
            <div>
              <Text strong style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                Health Check URL (Optional)
              </Text>
              {isEditingTemplate ? (
                <Input
                  value={healthCheckUrl}
                  onChange={e => setHealthCheckUrl(e.target.value)}
                  placeholder="http://localhost:{{add 9000 worktree.unique_id}}/health"
                  style={{ fontFamily: 'monospace', fontSize: 11 }}
                />
              ) : (
                <Text
                  code
                  style={{ fontSize: 11, wordBreak: 'break-all', display: 'block', padding: 8 }}
                >
                  {healthCheckUrl || <Text type="secondary">Not configured</Text>}
                </Text>
              )}
            </div>

            {/* Available Variables Info */}
            {isEditingTemplate && (
              <Alert
                message="Available Template Variables"
                description={
                  <div style={{ fontSize: 11, lineHeight: '1.6' }}>
                    <div>
                      <Text code>{'{{worktree.unique_id}}'}</Text> - Auto-assigned unique number (1,
                      2, 3, ...)
                    </div>
                    <div>
                      <Text code>{'{{worktree.name}}'}</Text> - Worktree name (e.g., "feat-auth")
                    </div>
                    <div>
                      <Text code>{'{{worktree.path}}'}</Text> - Absolute path to worktree directory
                    </div>
                    <div>
                      <Text code>{'{{repo.slug}}'}</Text> - Repository slug
                    </div>
                    <div>
                      <Text code>{'{{add a b}}'}</Text> - Math helpers (add, sub, mul, div, mod)
                    </div>
                    <div>
                      <Text code>{'{{custom.your_var}}'}</Text> - Custom variables (see below)
                    </div>
                  </div>
                }
                type="info"
                showIcon={false}
                style={{ marginTop: 8 }}
              />
            )}

            {/* Save/Cancel Buttons */}
            {isEditingTemplate && (
              <Space>
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  onClick={handleSaveTemplate}
                  disabled={!hasTemplateChanges}
                >
                  Save Template
                </Button>
                <Button onClick={handleCancelTemplate}>Cancel</Button>
              </Space>
            )}
          </Space>
        </Card>

        <Divider style={{ margin: '8px 0' }} />

        {/* ========== WORKTREE INSTANCE (Bottom Level) ========== */}
        <Card
          title={
            <Space>
              <PlayCircleOutlined />
              <span>Worktree Instance: {worktree.name}</span>
            </Space>
          }
          size="small"
        >
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {/* Built-in Variables (Read-only) */}
            <div>
              <Text strong style={{ fontSize: 13, display: 'block', marginBottom: 8 }}>
                Built-in Variables
              </Text>
              <Descriptions column={1} bordered size="small" style={{ fontSize: 11 }}>
                <Descriptions.Item label="worktree.unique_id">
                  <Text code>{worktree.worktree_unique_id}</Text>
                </Descriptions.Item>
                <Descriptions.Item label="worktree.name">
                  <Text code>{worktree.name}</Text>
                </Descriptions.Item>
                <Descriptions.Item label="worktree.path">
                  <Text code style={{ fontSize: 10 }}>
                    {worktree.path}
                  </Text>
                </Descriptions.Item>
                <Descriptions.Item label="repo.slug">
                  <Text code>{repo.slug}</Text>
                </Descriptions.Item>
              </Descriptions>
            </div>

            {/* Custom Context (Editable) */}
            <div>
              <Space
                style={{
                  width: '100%',
                  justifyContent: 'space-between',
                  marginBottom: 8,
                }}
              >
                <Text strong style={{ fontSize: 13 }}>
                  Custom Context (JSON)
                </Text>
                {!isEditingContext && (
                  <Button
                    type="text"
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => setIsEditingContext(true)}
                  >
                    Edit
                  </Button>
                )}
              </Space>
              <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 8 }}>
                Define custom variables accessible as{' '}
                <Text code style={{ fontSize: 11 }}>
                  {'{{custom.your_var}}'}
                </Text>{' '}
                in templates
              </Text>
              {isEditingContext ? (
                <>
                  <TextArea
                    value={customContextJson}
                    onChange={e => setCustomContextJson(e.target.value)}
                    placeholder='{\n  "feature_name": "authentication",\n  "extra_port": 3001\n}'
                    rows={6}
                    style={{ fontFamily: 'monospace', fontSize: 11 }}
                  />
                  <Space style={{ marginTop: 8 }}>
                    <Button
                      type="primary"
                      size="small"
                      icon={<SaveOutlined />}
                      onClick={handleSaveContext}
                    >
                      Save Context
                    </Button>
                    <Button size="small" onClick={handleCancelContext}>
                      Cancel
                    </Button>
                  </Space>
                </>
              ) : (
                <Paragraph
                  code
                  style={{
                    fontSize: 11,
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {customContextJson}
                </Paragraph>
              )}
            </div>

            {/* Resolved Commands Preview */}
            {hasEnvironmentConfig && (
              <div>
                <Text strong style={{ fontSize: 13, display: 'block', marginBottom: 8 }}>
                  Resolved Commands (Live Preview)
                </Text>
                <Space direction="vertical" size="small" style={{ width: '100%' }}>
                  {/* Up Command Preview */}
                  <div>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      Up:
                    </Text>
                    <Text
                      code
                      style={{
                        fontSize: 11,
                        display: 'block',
                        padding: 8,
                        background: upPreview.success ? token.colorSuccessBg : token.colorErrorBg,
                        border: `1px solid ${upPreview.success ? token.colorSuccessBorder : token.colorErrorBorder}`,
                        color: upPreview.success ? token.colorSuccessText : token.colorErrorText,
                        marginTop: 4,
                        wordBreak: 'break-word',
                        overflowWrap: 'break-word',
                      }}
                    >
                      {upPreview.result}
                    </Text>
                  </div>

                  {/* Down Command Preview */}
                  <div>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      Down:
                    </Text>
                    <Text
                      code
                      style={{
                        fontSize: 11,
                        display: 'block',
                        padding: 8,
                        background: downPreview.success ? token.colorSuccessBg : token.colorErrorBg,
                        border: `1px solid ${downPreview.success ? token.colorSuccessBorder : token.colorErrorBorder}`,
                        color: downPreview.success ? token.colorSuccessText : token.colorErrorText,
                        marginTop: 4,
                        wordBreak: 'break-word',
                        overflowWrap: 'break-word',
                      }}
                    >
                      {downPreview.result}
                    </Text>
                  </div>

                  {/* Health Check Preview */}
                  {healthPreview && (
                    <div>
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        Health Check:
                      </Text>
                      <Text
                        code
                        style={{
                          fontSize: 11,
                          display: 'block',
                          padding: 8,
                          background: healthPreview.success
                            ? token.colorSuccessBg
                            : token.colorErrorBg,
                          border: `1px solid ${healthPreview.success ? token.colorSuccessBorder : token.colorErrorBorder}`,
                          color: healthPreview.success
                            ? token.colorSuccessText
                            : token.colorErrorText,
                          marginTop: 4,
                          wordBreak: 'break-word',
                          overflowWrap: 'break-word',
                        }}
                      >
                        {healthPreview.result}
                      </Text>
                    </div>
                  )}
                </Space>
              </div>
            )}

            {/* Environment Status and Controls */}
            <div>
              <Text strong style={{ fontSize: 13, display: 'block', marginBottom: 8 }}>
                Environment Status
              </Text>

              {!hasEnvironmentConfig ? (
                <Alert
                  message="No Environment Configuration"
                  description="Configure environment commands in the Repository Template section above to enable start/stop controls."
                  type="warning"
                  showIcon
                  style={{ fontSize: 11 }}
                />
              ) : (
                <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                  {/* Status and Control Buttons */}
                  <Space size="middle" wrap>
                    {/* Status Badge */}
                    {getStatusBadge()}

                    {/* Control Buttons */}
                    <Button
                      type="primary"
                      size="small"
                      icon={isStarting ? <LoadingOutlined /> : <PlayCircleOutlined />}
                      onClick={handleStart}
                      disabled={
                        envStatus === 'running' ||
                        envStatus === 'starting' ||
                        isStarting ||
                        isStopping ||
                        isRestarting
                      }
                      loading={isStarting}
                    >
                      Start
                    </Button>

                    <Button
                      size="small"
                      icon={isStopping ? <LoadingOutlined /> : <PoweroffOutlined />}
                      onClick={handleStop}
                      loading={isStopping}
                      danger
                    >
                      Stop
                    </Button>

                    <Button
                      size="small"
                      icon={isRestarting ? <LoadingOutlined /> : <ReloadOutlined />}
                      onClick={handleRestart}
                      disabled={isStarting || isStopping || isRestarting}
                      loading={isRestarting}
                    >
                      Restart
                    </Button>
                  </Space>

                  {/* Process Info */}
                  {processInfo && envStatus === 'running' && (
                    <Descriptions column={1} bordered size="small" style={{ fontSize: 11 }}>
                      <Descriptions.Item label="Process ID">
                        <Text code>{processInfo.pid}</Text>
                      </Descriptions.Item>
                      <Descriptions.Item label="Uptime">
                        <Text>{getUptime() || 'Just started'}</Text>
                      </Descriptions.Item>
                    </Descriptions>
                  )}

                  {/* Health Check Status */}
                  {lastHealthCheck && (
                    <div
                      style={{
                        padding: 8,
                        background: token.colorBgContainer,
                        border: `1px solid ${token.colorBorder}`,
                        borderRadius: token.borderRadius,
                      }}
                    >
                      <Space size="small">
                        {isCheckingHealth && <Spin size="small" />}
                        {!isCheckingHealth && getHealthBadge()}
                        <Text style={{ fontSize: 11 }}>
                          Health: <Text strong>{lastHealthCheck.status}</Text>
                        </Text>
                        {lastHealthCheck.message && (
                          <Text type="secondary" style={{ fontSize: 11 }}>
                            ({lastHealthCheck.message})
                          </Text>
                        )}
                      </Space>
                      <div style={{ marginTop: 4 }}>
                        <Text type="secondary" style={{ fontSize: 10 }}>
                          Last checked: {formatTimestamp(lastHealthCheck.timestamp)}
                        </Text>
                      </div>
                    </div>
                  )}

                  {/* Error State */}
                  {envStatus === 'error' && lastHealthCheck?.message && (
                    <Alert
                      message="Environment Error"
                      description={lastHealthCheck.message}
                      type="error"
                      showIcon
                      style={{ fontSize: 11 }}
                    />
                  )}
                </Space>
              )}
            </div>
          </Space>
        </Card>
      </Space>
    </div>
  );
};
