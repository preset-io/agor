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
  CheckOutlined,
  CloseCircleOutlined,
  CodeOutlined,
  CopyOutlined,
  DownloadOutlined,
  EditOutlined,
  FileTextOutlined,
  FireOutlined,
  LoadingOutlined,
  PlayCircleOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  SaveOutlined,
  UploadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Input,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCopyToClipboard } from '../../../utils/clipboard';
import {
  getEnvironmentState,
  getEnvironmentStateDescription,
} from '../../../utils/environmentState';
import { useThemedMessage } from '../../../utils/message';
import { useThemedModal } from '../../../utils/modal';
import { EnvironmentLogsModal } from '../../EnvironmentLogsModal';

const { Paragraph } = Typography;
const { TextArea } = Input;

interface EnvironmentTabProps {
  worktree: Worktree;
  repo: Repo;
  client: AgorClient | null;
  onUpdateRepo?: (repoId: string, updates: Partial<Repo>) => void;
  onUpdateWorktree?: (worktreeId: string, updates: Partial<Worktree>) => void;
}

// Helper component for template field display (read-only view)
const TemplateField: React.FC<{ label: string; value: string }> = ({ label, value }) => {
  const [copied, handleCopy] = useCopyToClipboard();

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 }}>
      <Typography.Text type="secondary" style={{ minWidth: 120, textAlign: 'right', fontSize: 13 }}>
        {label}:
      </Typography.Text>
      <Typography.Text
        code
        style={{
          flex: 1,
          padding: '2px 6px',
          fontSize: 13,
          wordBreak: 'break-word',
          overflowWrap: 'break-word',
          cursor: value ? 'pointer' : 'default',
          opacity: value ? 1 : 0.5,
          lineHeight: 1.4,
        }}
        onClick={() => value && handleCopy(value, true)}
        title={value ? 'Click to copy' : undefined}
      >
        {value || 'Not configured'}
      </Typography.Text>
      {value && (
        <Button
          type="text"
          size="small"
          icon={copied ? <CheckOutlined /> : <CopyOutlined />}
          onClick={() => handleCopy(value, true)}
          style={{ flexShrink: 0 }}
        />
      )}
    </div>
  );
};

export const EnvironmentTab: React.FC<EnvironmentTabProps> = ({
  worktree,
  repo,
  client,
  onUpdateRepo,
  onUpdateWorktree,
}) => {
  const { token } = theme.useToken();
  const { showSuccess, showError, showWarning } = useThemedMessage();
  const { confirm } = useThemedModal();
  const hasEnvironmentConfig = !!repo.environment_config;

  // Repository template state (editable)
  const [isEditingTemplate, setIsEditingTemplate] = useState(false);
  const [upCommand, setUpCommand] = useState(repo.environment_config?.up_command || '');
  const [downCommand, setDownCommand] = useState(repo.environment_config?.down_command || '');
  const [nukeCommand, setNukeCommand] = useState(repo.environment_config?.nuke_command || '');
  const [healthCheckUrlTemplate, setHealthCheckUrlTemplate] = useState(
    repo.environment_config?.health_check?.url_template || ''
  );
  const [appUrlTemplate, setAppUrlTemplate] = useState(
    repo.environment_config?.app_url_template || ''
  );
  const [logsCommand, setLogsCommand] = useState(repo.environment_config?.logs_command || '');

  // Worktree static environment config state (editable, user-controlled)
  const [isEditingUrls, setIsEditingUrls] = useState(false);
  const [staticStartCommand, setStaticStartCommand] = useState(worktree.start_command || '');
  const [staticStopCommand, setStaticStopCommand] = useState(worktree.stop_command || '');
  const [staticNukeCommand, setStaticNukeCommand] = useState(worktree.nuke_command || '');
  const [staticHealthCheckUrl, setStaticHealthCheckUrl] = useState(worktree.health_check_url || '');
  const [staticAppUrl, setStaticAppUrl] = useState(worktree.app_url || '');
  const [staticLogsCommand, setStaticLogsCommand] = useState(worktree.logs_command || '');

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
  const [isNuking, setIsNuking] = useState(false);
  const [lastHealthCheck, setLastHealthCheck] = useState(
    worktree.environment_instance?.last_health_check
  );
  const [processInfo, setProcessInfo] = useState(worktree.environment_instance?.process);
  const [logsModalOpen, setLogsModalOpen] = useState(false);

  // Track previous worktree reference to detect actual prop changes (not just editing flag changes)
  const prevWorktreeRef = useRef(worktree);

  // Sync state when worktree prop changes
  useEffect(() => {
    // Always sync environment_instance fields (these update frequently)
    setEnvStatus(worktree.environment_instance?.status || 'stopped');
    setLastHealthCheck(worktree.environment_instance?.last_health_check);
    setProcessInfo(worktree.environment_instance?.process);

    // Check if worktree prop actually changed (not just editing flags)
    const worktreeChanged = prevWorktreeRef.current !== worktree;
    prevWorktreeRef.current = worktree;

    // Sync static environment config fields (only when not editing AND worktree prop changed)
    // This prevents overwriting with stale values when isEditingUrls flips but worktree hasn't updated yet
    if (!isEditingUrls && worktreeChanged) {
      setStaticStartCommand(worktree.start_command || '');
      setStaticStopCommand(worktree.stop_command || '');
      setStaticNukeCommand(worktree.nuke_command || '');
      setStaticHealthCheckUrl(worktree.health_check_url || '');
      setStaticAppUrl(worktree.app_url || '');
      setStaticLogsCommand(worktree.logs_command || '');
    }

    // Sync custom context (only when not editing AND worktree prop changed)
    if (!isEditingContext && worktreeChanged) {
      setCustomContextJson(JSON.stringify(worktree.custom_context || {}, null, 2));
    }
  }, [worktree, isEditingUrls, isEditingContext]);

  // WebSocket listener for real-time environment updates
  useEffect(() => {
    if (!client) return;

    const handleWorktreeUpdate = (data: unknown) => {
      const updatedWorktree = data as Worktree;
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
    return () => client.service('worktrees').removeListener('patched', handleWorktreeUpdate);
  }, [client, worktree.worktree_id, worktree.name]);

  // Environment control handlers
  const handleStart = async () => {
    if (!client) return;
    setIsStarting(true);
    try {
      await client.service(`worktrees/${worktree.worktree_id}/start`).create({});
      showSuccess('Environment started successfully');
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Failed to start environment');
    } finally {
      setIsStarting(false);
    }
  };

  const handleStop = async () => {
    if (!client) return;
    setIsStopping(true);
    try {
      await client.service(`worktrees/${worktree.worktree_id}/stop`).create({});
      showSuccess('Environment stopped successfully');
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Failed to stop environment');
    } finally {
      setIsStopping(false);
    }
  };

  const handleRestart = async () => {
    if (!client) return;
    setIsRestarting(true);
    try {
      await client.service(`worktrees/${worktree.worktree_id}/restart`).create({});
      showSuccess('Environment restarted successfully');
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Failed to restart environment');
    } finally {
      setIsRestarting(false);
    }
  };

  const handleNuke = async () => {
    if (!client) return;

    // Show confirmation dialog
    confirm({
      title: 'Nuke Environment?',
      icon: <FireOutlined style={{ color: '#ff4d4f' }} />,
      content: (
        <div>
          <p>
            <strong>This is a destructive operation!</strong>
          </p>
          <p>This will typically remove all volumes, data, and state for this environment.</p>
          <p>Are you sure you want to proceed?</p>
        </div>
      ),
      okText: 'Yes, Nuke It',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: async () => {
        setIsNuking(true);
        try {
          await client.service(`worktrees/${worktree.worktree_id}/nuke`).create({});
          showSuccess('Environment nuked successfully');
        } catch (error) {
          showError(error instanceof Error ? error.message : 'Failed to nuke environment');
        } finally {
          setIsNuking(false);
        }
      },
    });
  };

  // Regenerate static environment config from repo templates
  const handleRegenerateFromTemplate = async () => {
    if (!client || !onUpdateWorktree || !repo.environment_config) {
      showWarning('No repository environment configuration to regenerate from');
      return;
    }

    // Build template context
    let customContext = {};
    try {
      customContext = JSON.parse(customContextJson);
    } catch {
      // Invalid JSON, use empty object
    }

    const context = {
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

    // Helper to render a template with error handling
    const safeRenderTemplate = (template: string, fieldName: string): string | null => {
      try {
        return renderTemplate(template, context);
      } catch (error) {
        showError(
          `Failed to render ${fieldName}: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
        return null;
      }
    };

    // Render all 6 fields from templates
    const updates: Partial<Worktree> = {};

    if (repo.environment_config.up_command) {
      const result = safeRenderTemplate(repo.environment_config.up_command, 'start command');
      if (result === null) return;
      updates.start_command = result;
    }

    if (repo.environment_config.down_command) {
      const result = safeRenderTemplate(repo.environment_config.down_command, 'stop command');
      if (result === null) return;
      updates.stop_command = result;
    }

    if (repo.environment_config.nuke_command) {
      const result = safeRenderTemplate(repo.environment_config.nuke_command, 'nuke command');
      if (result === null) return;
      updates.nuke_command = result;
    }

    if (repo.environment_config.health_check?.url_template) {
      const result = safeRenderTemplate(
        repo.environment_config.health_check.url_template,
        'health check URL'
      );
      if (result === null) return;
      updates.health_check_url = result;
    }

    if (repo.environment_config.app_url_template) {
      const result = safeRenderTemplate(repo.environment_config.app_url_template, 'app URL');
      if (result === null) return;
      updates.app_url = result;
    }

    if (repo.environment_config.logs_command) {
      const result = safeRenderTemplate(repo.environment_config.logs_command, 'logs command');
      if (result === null) return;
      updates.logs_command = result;
    }

    // Update worktree with regenerated values
    // Note: onUpdateWorktree already shows a success toast, so we don't show another one here
    // Local state will be updated automatically via useEffect when the worktree prop changes
    onUpdateWorktree(worktree.worktree_id, updates);
  };

  // Check if template has unsaved changes
  const hasTemplateChanges = useMemo(() => {
    if (!repo.environment_config)
      return (
        upCommand ||
        downCommand ||
        nukeCommand ||
        healthCheckUrlTemplate ||
        appUrlTemplate ||
        logsCommand
      );
    return (
      upCommand !== repo.environment_config.up_command ||
      downCommand !== repo.environment_config.down_command ||
      nukeCommand !== (repo.environment_config.nuke_command || '') ||
      healthCheckUrlTemplate !== (repo.environment_config.health_check?.url_template || '') ||
      appUrlTemplate !== (repo.environment_config.app_url_template || '') ||
      logsCommand !== (repo.environment_config.logs_command || '')
    );
  }, [
    upCommand,
    downCommand,
    nukeCommand,
    healthCheckUrlTemplate,
    appUrlTemplate,
    logsCommand,
    repo.environment_config,
  ]);

  const handleSaveTemplate = () => {
    if (!onUpdateRepo) return;

    const newConfig: RepoEnvironmentConfig = {
      up_command: upCommand,
      down_command: downCommand,
      nuke_command: nukeCommand || undefined,
      health_check: healthCheckUrlTemplate
        ? {
            type: 'http',
            url_template: healthCheckUrlTemplate,
          }
        : undefined,
      app_url_template: appUrlTemplate || undefined,
      logs_command: logsCommand || undefined,
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
    setNukeCommand(repo.environment_config?.nuke_command || '');
    setHealthCheckUrlTemplate(repo.environment_config?.health_check?.url_template || '');
    setAppUrlTemplate(repo.environment_config?.app_url_template || '');
    setLogsCommand(repo.environment_config?.logs_command || '');
    setIsEditingTemplate(false);
  };

  const handleCancelContext = () => {
    setCustomContextJson(JSON.stringify(worktree.custom_context || {}, null, 2));
    setIsEditingContext(false);
  };

  // Import from .agor.yml
  const handleImport = async () => {
    if (!client || !onUpdateRepo) return;

    try {
      const updated = (await client
        .service(`repos/${repo.repo_id}/import-agor-yml`)
        .create({})) as Repo;

      // Note: onUpdateRepo already shows a success toast, so we don't show another one here
      // Update local state
      if (updated.environment_config) {
        setUpCommand(updated.environment_config.up_command || '');
        setDownCommand(updated.environment_config.down_command || '');
        setNukeCommand(updated.environment_config.nuke_command || '');
        setHealthCheckUrlTemplate(updated.environment_config.health_check?.url_template || '');
        setAppUrlTemplate(updated.environment_config.app_url_template || '');
        setLogsCommand(updated.environment_config.logs_command || '');
      }

      // Notify parent
      onUpdateRepo(repo.repo_id, { environment_config: updated.environment_config });
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Failed to import .agor.yml');
    }
  };

  // Export to .agor.yml
  const handleExport = async () => {
    if (!client) return;

    try {
      await client.service(`repos/${repo.repo_id}/export-agor-yml`).create({});
      showSuccess('Environment configuration exported to .agor.yml');
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Failed to export .agor.yml');
    }
  };

  // Auto-enable editing if no config exists
  if (!hasEnvironmentConfig && !isEditingTemplate) {
    // Automatically show the form in edit mode
    setTimeout(() => setIsEditingTemplate(true), 0);
  }

  // Get inferred state by combining runtime status + health check
  const inferredState = getEnvironmentState(worktree.environment_instance);

  // Helper to get status badge showing inferred state
  const getStatusBadge = () => {
    const stateText = getEnvironmentStateDescription(inferredState);

    switch (inferredState) {
      case 'healthy':
        return (
          <Typography.Text strong style={{ color: token.colorSuccess }}>
            {stateText}
          </Typography.Text>
        );
      case 'unhealthy':
        return (
          <Typography.Text strong style={{ color: token.colorError }}>
            {stateText}
          </Typography.Text>
        );
      case 'running':
        return (
          <Typography.Text strong style={{ color: token.colorInfo }}>
            {stateText}
          </Typography.Text>
        );
      case 'starting':
      case 'stopping':
        return <Typography.Text strong>{stateText}</Typography.Text>;
      case 'error':
        return (
          <Typography.Text strong type="danger">
            {stateText}
          </Typography.Text>
        );
      default:
        return <Typography.Text type="secondary">{stateText}</Typography.Text>;
    }
  };

  // Helper to get health badge icon (detailed view)
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
  const _formatTimestamp = (timestamp?: string) => {
    if (!timestamp) return 'Never';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);

    if (diffSec < 5) return null; // Don't show "just now" - not useful
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    return date.toLocaleTimeString();
  };

  // Calculate uptime
  const _getUptime = () => {
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
    <div style={{ width: '100%', maxHeight: '70vh', overflowY: 'auto' }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Alert
          message={
            <span>
              Environment templates can be version-controlled using <code>.agor.yml</code>.{' '}
              <a
                href="https://agor.live/guide/environment-configuration"
                target="_blank"
                rel="noopener noreferrer"
              >
                View documentation
              </a>
            </span>
          }
          type="info"
          showIcon
        />

        {/* ========== ENVIRONMENT CONTROLS (Top) ========== */}
        {hasEnvironmentConfig && (
          <Card size="small">
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              {/* Status and Control Buttons - Single Row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {/* Spinner (only when running) */}
                {envStatus === 'running' && <Spin size="small" />}

                {/* Health Status Icon */}
                {lastHealthCheck && getHealthBadge()}

                {/* Status Badge */}
                {getStatusBadge()}

                {/* Spacer */}
                <div style={{ flex: 1 }} />

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

                {worktree.nuke_command && (
                  <Button
                    size="small"
                    icon={isNuking ? <LoadingOutlined /> : <FireOutlined />}
                    onClick={handleNuke}
                    disabled={isStarting || isStopping || isRestarting || isNuking}
                    loading={isNuking}
                    danger
                    title="Nuke environment (destructive - removes all data and volumes)"
                  >
                    Nuke
                  </Button>
                )}

                <Button
                  size="small"
                  icon={<FileTextOutlined />}
                  onClick={() => setLogsModalOpen(true)}
                  disabled={!repo.environment_config?.logs_command}
                  title={
                    !repo.environment_config?.logs_command
                      ? 'Configure a logs command in the template to enable'
                      : undefined
                  }
                >
                  View Logs
                </Button>
              </div>

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
          </Card>
        )}

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
            <Space size="small">
              <Tooltip title="Import environment configuration from .agor.yml in repository root">
                <Button type="text" size="small" icon={<DownloadOutlined />} onClick={handleImport}>
                  Import
                </Button>
              </Tooltip>
              {!isEditingTemplate && (
                <>
                  <Tooltip
                    title={
                      hasEnvironmentConfig
                        ? 'Export current environment configuration to .agor.yml in repository root'
                        : 'No configuration to export'
                    }
                  >
                    <Button
                      type="text"
                      size="small"
                      icon={<UploadOutlined />}
                      onClick={handleExport}
                      disabled={!hasEnvironmentConfig}
                    >
                      Export
                    </Button>
                  </Tooltip>
                  <Button
                    type="text"
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => setIsEditingTemplate(true)}
                  >
                    Edit
                  </Button>
                </>
              )}
            </Space>
          }
        >
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {isEditingTemplate ? (
              <>
                {/* Up Command */}
                <div>
                  <Typography.Text
                    strong
                    style={{ fontSize: 12, display: 'block', marginBottom: 4 }}
                  >
                    Up Command (Start Environment)
                  </Typography.Text>
                  <TextArea
                    value={upCommand}
                    onChange={(e) => setUpCommand(e.target.value)}
                    placeholder="DAEMON_PORT={{add 3000 worktree.unique_id}} UI_PORT={{add 5000 worktree.unique_id}} docker compose -p {{worktree.name}} up -d"
                    rows={3}
                    style={{ fontFamily: 'monospace', fontSize: 11 }}
                  />
                  <Typography.Text
                    type="secondary"
                    style={{ fontSize: 10, display: 'block', marginTop: 4 }}
                  >
                    ⚠️ Command should start services in the background and return (e.g., docker
                    compose up -d, systemctl start, etc.)
                  </Typography.Text>
                </div>

                {/* Down Command */}
                <div>
                  <Typography.Text
                    strong
                    style={{ fontSize: 12, display: 'block', marginBottom: 4 }}
                  >
                    Down Command (Stop Environment)
                  </Typography.Text>
                  <TextArea
                    value={downCommand}
                    onChange={(e) => setDownCommand(e.target.value)}
                    placeholder="docker compose -p {{worktree.name}} down"
                    rows={2}
                    style={{ fontFamily: 'monospace', fontSize: 11 }}
                  />
                  <Typography.Text
                    type="secondary"
                    style={{ fontSize: 10, display: 'block', marginTop: 4 }}
                  >
                    Command should stop services and return (e.g., docker compose down, systemctl
                    stop, etc.)
                  </Typography.Text>
                </div>

                {/* Nuke Command */}
                <div>
                  <Typography.Text
                    strong
                    style={{ fontSize: 12, display: 'block', marginBottom: 4 }}
                  >
                    Nuke Command (Destructive - Optional)
                  </Typography.Text>
                  <TextArea
                    value={nukeCommand}
                    onChange={(e) => setNukeCommand(e.target.value)}
                    placeholder="docker compose -p {{worktree.name}} down -v"
                    rows={2}
                    style={{ fontFamily: 'monospace', fontSize: 11 }}
                  />
                  <Typography.Text
                    type="secondary"
                    style={{ fontSize: 10, display: 'block', marginTop: 4 }}
                  >
                    💣 Destructive command that removes all volumes, data, and state (e.g., docker
                    compose down -v). Requires confirmation before execution.
                  </Typography.Text>
                </div>

                {/* Health Check URL */}
                <div>
                  <Typography.Text
                    strong
                    style={{ fontSize: 12, display: 'block', marginBottom: 4 }}
                  >
                    Health Check URL (Optional)
                  </Typography.Text>
                  <Input
                    value={healthCheckUrlTemplate}
                    onChange={(e) => setHealthCheckUrlTemplate(e.target.value)}
                    placeholder="http://localhost:{{add 9000 worktree.unique_id}}/health"
                    style={{ fontFamily: 'monospace', fontSize: 11 }}
                  />
                </div>

                {/* App URL */}
                <div>
                  <Typography.Text
                    strong
                    style={{ fontSize: 12, display: 'block', marginBottom: 4 }}
                  >
                    App URL
                  </Typography.Text>
                  <Input
                    value={appUrlTemplate}
                    onChange={(e) => setAppUrlTemplate(e.target.value)}
                    placeholder="http://localhost:{{add 5000 worktree.unique_id}}"
                    style={{ fontFamily: 'monospace', fontSize: 11 }}
                  />
                  <Typography.Text
                    type="secondary"
                    style={{ fontSize: 10, display: 'block', marginTop: 4 }}
                  >
                    URL to access the running app. This will appear as a clickable link when the
                    environment is running.
                  </Typography.Text>
                </div>

                {/* Logs Command */}
                <div>
                  <Typography.Text
                    strong
                    style={{ fontSize: 12, display: 'block', marginBottom: 4 }}
                  >
                    Logs Command (Optional)
                  </Typography.Text>
                  <TextArea
                    value={logsCommand}
                    onChange={(e) => setLogsCommand(e.target.value)}
                    placeholder="docker compose -p {{worktree.name}} logs --tail=100"
                    rows={2}
                    style={{ fontFamily: 'monospace', fontSize: 11 }}
                  />
                  <Typography.Text
                    type="secondary"
                    style={{ fontSize: 10, display: 'block', marginTop: 4 }}
                  >
                    Command to fetch recent logs (non-streaming). Should return quickly with a
                    snapshot of recent logs.
                  </Typography.Text>
                </div>
              </>
            ) : (
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <TemplateField label="Up Command" value={upCommand} />
                <TemplateField label="Down Command" value={downCommand} />
                <TemplateField label="Nuke Command" value={nukeCommand} />
                <TemplateField label="Health Check URL" value={healthCheckUrlTemplate} />
                <TemplateField label="App URL" value={appUrlTemplate} />
                <TemplateField label="Logs Command" value={logsCommand} />
              </Space>
            )}

            {/* Available Variables Info */}
            {isEditingTemplate && (
              <Alert
                message="Available Template Variables"
                description={
                  <div style={{ fontSize: 11, lineHeight: '1.6' }}>
                    <div>
                      <Typography.Text code>{'{{worktree.unique_id}}'}</Typography.Text> -
                      Auto-assigned unique number (1, 2, 3, ...)
                    </div>
                    <div>
                      <Typography.Text code>{'{{worktree.name}}'}</Typography.Text> - Worktree name
                      (e.g., "feat-auth")
                    </div>
                    <div>
                      <Typography.Text code>{'{{worktree.path}}'}</Typography.Text> - Absolute path
                      to worktree directory
                    </div>
                    <div>
                      <Typography.Text code>{'{{repo.slug}}'}</Typography.Text> - Repository slug
                    </div>
                    <div>
                      <Typography.Text code>{'{{add a b}}'}</Typography.Text> - Math helpers (add,
                      sub, mul, div, mod)
                    </div>
                    <div>
                      <Typography.Text code>{'{{custom.your_var}}'}</Typography.Text> - Custom
                      variables (see below)
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
              <Typography.Text strong style={{ fontSize: 13, display: 'block', marginBottom: 8 }}>
                Built-in Variables
              </Typography.Text>
              <Descriptions column={1} bordered size="small" style={{ fontSize: 11 }}>
                <Descriptions.Item label="worktree.unique_id">
                  <Typography.Text code>{worktree.worktree_unique_id}</Typography.Text>
                </Descriptions.Item>
                <Descriptions.Item label="worktree.name">
                  <Typography.Text code>{worktree.name}</Typography.Text>
                </Descriptions.Item>
                <Descriptions.Item label="worktree.path">
                  <Typography.Text
                    code
                    style={{ fontSize: 10 }}
                    copyable={{
                      text: worktree.path,
                      tooltips: ['Copy path', 'Copied!'],
                    }}
                  >
                    {worktree.path}
                  </Typography.Text>
                </Descriptions.Item>
                <Descriptions.Item label="repo.slug">
                  <Typography.Text code>{repo.slug}</Typography.Text>
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
                <Typography.Text strong style={{ fontSize: 13 }}>
                  Custom Context (JSON)
                </Typography.Text>
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
              <Typography.Text
                type="secondary"
                style={{ fontSize: 11, display: 'block', marginBottom: 8 }}
              >
                Define custom variables accessible as{' '}
                <Typography.Text code style={{ fontSize: 11 }}>
                  {'{{custom.your_var}}'}
                </Typography.Text>{' '}
                in templates
              </Typography.Text>
              {isEditingContext ? (
                <>
                  <TextArea
                    value={customContextJson}
                    onChange={(e) => setCustomContextJson(e.target.value)}
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

            {/* Static URLs (Editable) */}
            <div>
              <Space
                style={{
                  width: '100%',
                  justifyContent: 'space-between',
                  marginBottom: 8,
                }}
              >
                <Typography.Text strong style={{ fontSize: 13 }}>
                  Environment Configuration (Direct Edit)
                </Typography.Text>
                {!isEditingUrls && (
                  <Space size={4}>
                    <Button
                      type="text"
                      size="small"
                      icon={<ReloadOutlined />}
                      onClick={handleRegenerateFromTemplate}
                      disabled={!repo.environment_config}
                      title={
                        repo.environment_config
                          ? 'Regenerate from repository templates'
                          : 'No repository templates configured'
                      }
                    >
                      Regenerate
                    </Button>
                    <Button
                      type="text"
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => setIsEditingUrls(true)}
                    >
                      Edit
                    </Button>
                  </Space>
                )}
              </Space>
              <Typography.Text
                type="secondary"
                style={{ fontSize: 11, display: 'block', marginBottom: 8 }}
              >
                Static configuration initialized from templates at worktree creation. Edit directly
                to override.
              </Typography.Text>
              {isEditingUrls ? (
                <>
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    <div>
                      <Typography.Text
                        strong
                        style={{ fontSize: 12, display: 'block', marginBottom: 4 }}
                      >
                        Start Command
                      </Typography.Text>
                      <Input
                        value={staticStartCommand}
                        onChange={(e) => setStaticStartCommand(e.target.value)}
                        placeholder="pnpm dev"
                        style={{ fontFamily: 'monospace', fontSize: 11 }}
                      />
                    </div>
                    <div>
                      <Typography.Text
                        strong
                        style={{ fontSize: 12, display: 'block', marginBottom: 4 }}
                      >
                        Stop Command (Optional)
                      </Typography.Text>
                      <Input
                        value={staticStopCommand}
                        onChange={(e) => setStaticStopCommand(e.target.value)}
                        placeholder="pkill -f 'pnpm dev'"
                        style={{ fontFamily: 'monospace', fontSize: 11 }}
                      />
                    </div>
                    <div>
                      <Typography.Text
                        strong
                        style={{ fontSize: 12, display: 'block', marginBottom: 4 }}
                      >
                        Nuke Command (Optional)
                      </Typography.Text>
                      <Input
                        value={staticNukeCommand}
                        onChange={(e) => setStaticNukeCommand(e.target.value)}
                        placeholder="docker compose down -v"
                        style={{ fontFamily: 'monospace', fontSize: 11 }}
                      />
                    </div>
                    <div>
                      <Typography.Text
                        strong
                        style={{ fontSize: 12, display: 'block', marginBottom: 4 }}
                      >
                        Health Check URL (Optional)
                      </Typography.Text>
                      <Input
                        value={staticHealthCheckUrl}
                        onChange={(e) => setStaticHealthCheckUrl(e.target.value)}
                        placeholder="http://localhost:5173/health"
                        style={{ fontFamily: 'monospace', fontSize: 11 }}
                      />
                    </div>
                    <div>
                      <Typography.Text
                        strong
                        style={{ fontSize: 12, display: 'block', marginBottom: 4 }}
                      >
                        App URL
                      </Typography.Text>
                      <Input
                        value={staticAppUrl}
                        onChange={(e) => setStaticAppUrl(e.target.value)}
                        placeholder="http://localhost:5173"
                        style={{ fontFamily: 'monospace', fontSize: 11 }}
                      />
                    </div>
                    <div>
                      <Typography.Text
                        strong
                        style={{ fontSize: 12, display: 'block', marginBottom: 4 }}
                      >
                        Logs Command (Optional)
                      </Typography.Text>
                      <Input
                        value={staticLogsCommand}
                        onChange={(e) => setStaticLogsCommand(e.target.value)}
                        placeholder="docker logs agor-daemon"
                        style={{ fontFamily: 'monospace', fontSize: 11 }}
                      />
                    </div>
                  </Space>
                  <Space style={{ marginTop: 8 }}>
                    <Button
                      type="primary"
                      size="small"
                      icon={<SaveOutlined />}
                      onClick={() => {
                        if (!onUpdateWorktree) return;
                        onUpdateWorktree(worktree.worktree_id, {
                          start_command: staticStartCommand || undefined,
                          stop_command: staticStopCommand || undefined,
                          nuke_command: staticNukeCommand || undefined,
                          health_check_url: staticHealthCheckUrl || undefined,
                          app_url: staticAppUrl || undefined,
                          logs_command: staticLogsCommand || undefined,
                        });
                        setIsEditingUrls(false);
                      }}
                    >
                      Save Configuration
                    </Button>
                    <Button
                      size="small"
                      onClick={() => {
                        setStaticStartCommand(worktree.start_command || '');
                        setStaticStopCommand(worktree.stop_command || '');
                        setStaticNukeCommand(worktree.nuke_command || '');
                        setStaticHealthCheckUrl(worktree.health_check_url || '');
                        setStaticAppUrl(worktree.app_url || '');
                        setStaticLogsCommand(worktree.logs_command || '');
                        setIsEditingUrls(false);
                      }}
                    >
                      Cancel
                    </Button>
                  </Space>
                </>
              ) : (
                <Descriptions column={1} bordered size="small" style={{ fontSize: 11 }}>
                  <Descriptions.Item label="Start Command">
                    <Typography.Text
                      code
                      copyable={staticStartCommand ? { text: staticStartCommand } : false}
                    >
                      {staticStartCommand || (
                        <Typography.Text type="secondary">(not set)</Typography.Text>
                      )}
                    </Typography.Text>
                  </Descriptions.Item>
                  <Descriptions.Item label="Stop Command">
                    <Typography.Text
                      code
                      copyable={staticStopCommand ? { text: staticStopCommand } : false}
                    >
                      {staticStopCommand || (
                        <Typography.Text type="secondary">(not set)</Typography.Text>
                      )}
                    </Typography.Text>
                  </Descriptions.Item>
                  <Descriptions.Item label="Nuke Command">
                    <Typography.Text
                      code
                      copyable={staticNukeCommand ? { text: staticNukeCommand } : false}
                    >
                      {staticNukeCommand || (
                        <Typography.Text type="secondary">(not set)</Typography.Text>
                      )}
                    </Typography.Text>
                  </Descriptions.Item>
                  <Descriptions.Item label="Health Check URL">
                    <Typography.Text
                      code
                      copyable={staticHealthCheckUrl ? { text: staticHealthCheckUrl } : false}
                    >
                      {staticHealthCheckUrl || (
                        <Typography.Text type="secondary">(not set)</Typography.Text>
                      )}
                    </Typography.Text>
                  </Descriptions.Item>
                  <Descriptions.Item label="App URL">
                    <Typography.Text code copyable={staticAppUrl ? { text: staticAppUrl } : false}>
                      {staticAppUrl || (
                        <Typography.Text type="secondary">(not set)</Typography.Text>
                      )}
                    </Typography.Text>
                  </Descriptions.Item>
                  <Descriptions.Item label="Logs Command">
                    <Typography.Text
                      code
                      copyable={staticLogsCommand ? { text: staticLogsCommand } : false}
                    >
                      {staticLogsCommand || (
                        <Typography.Text type="secondary">(not set)</Typography.Text>
                      )}
                    </Typography.Text>
                  </Descriptions.Item>
                </Descriptions>
              )}
            </div>
          </Space>
        </Card>
      </Space>

      {/* Environment Logs Modal */}
      <EnvironmentLogsModal
        open={logsModalOpen}
        onClose={() => setLogsModalOpen(false)}
        worktree={worktree}
        client={client}
      />
    </div>
  );
};
