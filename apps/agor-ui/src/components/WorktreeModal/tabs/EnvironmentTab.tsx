/**
 * Environment Tab — v2 variants UI.
 *
 * Layout matches `docs/designs/env-command-variants.md` §4:
 *   - Top editor: repo-level `environment` (variants + default). Admin-only to edit.
 *   - Variant picker + Render button (members+ via `managed_envs_minimum_role`).
 *   - Bottom editor: rendered snapshot on the worktree (start, stop, ...).
 *     Admin-only to edit; members see read-only.
 *
 * Read/edit exclusivity: only one editor is "active" at a time.
 *
 * YAML is parsed/emitted via `@agor-live/client/yaml`, which re-exports
 * `@agor/core/yaml` (a browser-safe thin wrapper over `js-yaml`). Keeps the
 * YAML dep centralized in core rather than pulling it directly into the UI.
 */

import {
  type AgorClient,
  type Repo,
  type RepoEnvironment,
  validateRepoEnvironment,
  type Worktree,
} from '@agor-live/client';
import * as yaml from '@agor-live/client/yaml';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  CodeOutlined,
  DownloadOutlined,
  EditOutlined,
  FileTextOutlined,
  FireOutlined,
  LoadingOutlined,
  PlayCircleOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  SaveOutlined,
  ThunderboltOutlined,
  UploadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Alert, Button, Card, Select, Space, Spin, Tag, Tooltip, Typography, theme } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuthConfig } from '../../../hooks/useAuthConfig';
import { usePermissions } from '../../../hooks/usePermissions';
import {
  getEnvironmentState,
  getEnvironmentStateDescription,
} from '../../../utils/environmentState';
import { useThemedMessage } from '../../../utils/message';
import { useThemedModal } from '../../../utils/modal';
import { CodeEditor } from '../../CodeEditor';
import { EnvironmentLogsModal } from '../../EnvironmentLogsModal';

const DOCS_URL = 'https://agor.live/guide/environment-configuration';

interface EnvironmentTabProps {
  worktree: Worktree;
  repo: Repo;
  client: AgorClient | null;
  onUpdateRepo?: (repoId: string, updates: Partial<Repo>) => void;
  onUpdateWorktree?: (worktreeId: string, updates: Partial<Worktree>) => void;
}

/**
 * Shape of the bottom editor — rendered commands persisted on the worktree.
 * Keys match v2 variant field names; `health` maps to `health_check_url` and
 * `app` maps to `app_url` on the wire.
 */
interface WorktreeRenderedSnapshot {
  start?: string;
  stop?: string;
  nuke?: string;
  logs?: string;
  health?: string;
  app?: string;
}

function snapshotFromWorktree(wt: Worktree): WorktreeRenderedSnapshot {
  return {
    start: wt.start_command || undefined,
    stop: wt.stop_command || undefined,
    nuke: wt.nuke_command || undefined,
    logs: wt.logs_command || undefined,
    health: wt.health_check_url || undefined,
    app: wt.app_url || undefined,
  };
}

function prettyYaml(value: unknown): string {
  try {
    return yaml.dump(value, { indent: 2, lineWidth: 100, noRefs: true });
  } catch {
    return '';
  }
}

export const EnvironmentTab: React.FC<EnvironmentTabProps> = ({
  worktree,
  repo,
  client,
  onUpdateRepo,
  onUpdateWorktree,
}) => {
  const { token } = theme.useToken();
  const { showSuccess, showError } = useThemedMessage();
  const { confirm } = useThemedModal();
  const { isAdmin, hasRole } = usePermissions();
  const { featuresConfig } = useAuthConfig();

  // ----- Permission gating -----
  const managedEnvsMinimumRole = featuresConfig?.managedEnvsMinimumRole ?? 'member';
  const canTriggerEnv =
    managedEnvsMinimumRole !== 'none' &&
    hasRole(managedEnvsMinimumRole as Exclude<typeof managedEnvsMinimumRole, 'none'>);
  const triggerDisabledTooltip = canTriggerEnv
    ? undefined
    : managedEnvsMinimumRole === 'none'
      ? 'Managed environments are disabled on this instance'
      : `Requires ${managedEnvsMinimumRole} role or higher`;

  // ----- Repo-level editor state (YAML representation of repo.environment) -----
  const [isEditingRepo, setIsEditingRepo] = useState(false);
  const [repoYamlText, setRepoYamlText] = useState(() =>
    repo.environment ? prettyYaml(repo.environment) : ''
  );
  const [repoYamlError, setRepoYamlError] = useState<string | null>(null);

  // ----- Worktree snapshot editor state -----
  const [isEditingSnapshot, setIsEditingSnapshot] = useState(false);
  const [snapshotYamlText, setSnapshotYamlText] = useState(() =>
    prettyYaml(snapshotFromWorktree(worktree))
  );
  const [snapshotYamlError, setSnapshotYamlError] = useState<string | null>(null);

  // ----- Variant picker -----
  const availableVariants: string[] = repo.environment
    ? Object.keys(repo.environment.variants)
    : [];
  const initialVariant =
    worktree.environment_variant ?? repo.environment?.default ?? availableVariants[0] ?? '';
  const [selectedVariant, setSelectedVariant] = useState(initialVariant);
  const [isRendering, setIsRendering] = useState(false);

  // ----- Runtime env state (start/stop/logs) -----
  const [envStatus, setEnvStatus] = useState(worktree.environment_instance?.status || 'stopped');
  const [lastHealthCheck, setLastHealthCheck] = useState(
    worktree.environment_instance?.last_health_check
  );
  const [lastError, setLastError] = useState(worktree.environment_instance?.last_error);
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isNuking, setIsNuking] = useState(false);
  const [logsModalOpen, setLogsModalOpen] = useState(false);

  // Re-sync local editor state when the worktree/repo props change (but not
  // mid-edit — users shouldn't lose their in-flight text).
  const prevWorktreeRef = useRef(worktree);
  const prevRepoRef = useRef(repo);

  useEffect(() => {
    setEnvStatus(worktree.environment_instance?.status || 'stopped');
    setLastHealthCheck(worktree.environment_instance?.last_health_check);
    setLastError(worktree.environment_instance?.last_error);

    const worktreeChanged = prevWorktreeRef.current !== worktree;
    prevWorktreeRef.current = worktree;

    if (worktreeChanged && !isEditingSnapshot) {
      setSnapshotYamlText(prettyYaml(snapshotFromWorktree(worktree)));
      setSnapshotYamlError(null);
    }
    if (worktreeChanged) {
      // Keep picker aligned with what's actually rendered on the worktree
      // (unless the user is mid-edit via the picker — that's fine, the picker
      // is just a client-side selection until Render is clicked).
      if (worktree.environment_variant) {
        setSelectedVariant(worktree.environment_variant);
      }
    }
  }, [worktree, isEditingSnapshot]);

  useEffect(() => {
    const repoChanged = prevRepoRef.current !== repo;
    prevRepoRef.current = repo;
    if (repoChanged && !isEditingRepo) {
      setRepoYamlText(repo.environment ? prettyYaml(repo.environment) : '');
      setRepoYamlError(null);
    }
  }, [repo, isEditingRepo]);

  // WebSocket listener for real-time environment updates
  useEffect(() => {
    if (!client) return;
    const handleWorktreeUpdate = (data: unknown) => {
      const updated = data as Worktree;
      if (updated.worktree_id === worktree.worktree_id) {
        setEnvStatus(updated.environment_instance?.status || 'stopped');
        setLastHealthCheck(updated.environment_instance?.last_health_check);
        setLastError(updated.environment_instance?.last_error);
      }
    };
    client.service('worktrees').on('patched', handleWorktreeUpdate);
    return () => client.service('worktrees').removeListener('patched', handleWorktreeUpdate);
  }, [client, worktree.worktree_id]);

  // ----- Runtime handlers (start/stop/restart/nuke) -----
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
  const handleNuke = () => {
    if (!client) return;
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

  // ----- Render (variant → snapshot) -----
  const variantChanged = selectedVariant !== worktree.environment_variant;
  const renderDisabled =
    !canTriggerEnv ||
    !repo.environment ||
    !selectedVariant ||
    (variantChanged && !isAdmin) ||
    isRendering;
  const renderDisabledTooltip = !canTriggerEnv
    ? triggerDisabledTooltip
    : !repo.environment
      ? 'Configure repo environment variants first'
      : variantChanged && !isAdmin
        ? 'Only admins can change the worktree variant'
        : undefined;

  const performRender = async () => {
    if (!client) return;
    setIsRendering(true);
    try {
      const updated = (await client
        .service(`worktrees/${worktree.worktree_id}/render-environment`)
        .create({ variant: selectedVariant })) as Worktree;
      showSuccess(
        variantChanged
          ? `Rendered variant "${selectedVariant}" to worktree`
          : 'Re-rendered worktree environment'
      );
      // Let parent update, but also refresh local editor immediately so users
      // see the new snapshot without waiting for a WS push.
      setSnapshotYamlText(prettyYaml(snapshotFromWorktree(updated)));
      setSnapshotYamlError(null);
      if (updated.environment_variant) setSelectedVariant(updated.environment_variant);
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Failed to render environment');
    } finally {
      setIsRendering(false);
    }
  };

  const handleRender = () => {
    if (renderDisabled) return;
    // If admin has unsaved manual snapshot edits, confirm before discarding them.
    const snapshotDirty =
      isAdmin && snapshotYamlText.trim() !== prettyYaml(snapshotFromWorktree(worktree)).trim();
    if (snapshotDirty) {
      confirm({
        title: 'Discard local snapshot edits?',
        content:
          'The worktree has unsaved manual edits in the snapshot editor. Rendering will overwrite them.',
        okText: 'Render anyway',
        okType: 'danger',
        cancelText: 'Cancel',
        onOk: performRender,
      });
      return;
    }
    void performRender();
  };

  // ----- Repo editor save/cancel -----
  // Validation goes through the shared core validator so UI / daemon / import
  // all enforce the same schema invariants (required start/stop, extends
  // single-level, default-in-variants, etc.). See
  // `packages/core/src/config/variant-resolver.ts`.
  const validateRepoYaml = (text: string): RepoEnvironment | null => {
    if (!text.trim()) {
      setRepoYamlError('Empty — paste or write a RepoEnvironment YAML document');
      return null;
    }
    let parsed: unknown;
    try {
      parsed = yaml.load(text);
    } catch (err) {
      setRepoYamlError(err instanceof Error ? err.message : 'Invalid YAML');
      return null;
    }
    try {
      const validated = validateRepoEnvironment(parsed);
      setRepoYamlError(null);
      return validated;
    } catch (err) {
      setRepoYamlError(err instanceof Error ? err.message : 'Invalid RepoEnvironment');
      return null;
    }
  };

  const handleSaveRepo = () => {
    if (!onUpdateRepo) return;
    const parsed = validateRepoYaml(repoYamlText);
    if (!parsed) return;
    onUpdateRepo(repo.repo_id, { environment: parsed });
    setIsEditingRepo(false);
  };

  const handleCancelRepo = () => {
    setRepoYamlText(repo.environment ? prettyYaml(repo.environment) : '');
    setRepoYamlError(null);
    setIsEditingRepo(false);
  };

  // ----- Snapshot editor save/cancel -----
  const validateSnapshotYaml = (text: string): WorktreeRenderedSnapshot | null => {
    if (!text.trim()) {
      setSnapshotYamlError('Empty — provide at least `start` and `stop`');
      return null;
    }
    let parsed: unknown;
    try {
      parsed = yaml.load(text);
    } catch (err) {
      setSnapshotYamlError(err instanceof Error ? err.message : 'Invalid YAML');
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      setSnapshotYamlError('Expected a YAML mapping (object)');
      return null;
    }
    const obj = parsed as WorktreeRenderedSnapshot;
    if (!obj.start || typeof obj.start !== 'string') {
      setSnapshotYamlError('`start` is required and must be a string');
      return null;
    }
    if (!obj.stop || typeof obj.stop !== 'string') {
      setSnapshotYamlError('`stop` is required and must be a string');
      return null;
    }
    setSnapshotYamlError(null);
    return obj;
  };

  const handleSaveSnapshot = () => {
    if (!onUpdateWorktree) return;
    const parsed = validateSnapshotYaml(snapshotYamlText);
    if (!parsed) return;
    onUpdateWorktree(worktree.worktree_id, {
      start_command: parsed.start || undefined,
      stop_command: parsed.stop || undefined,
      nuke_command: parsed.nuke || undefined,
      logs_command: parsed.logs || undefined,
      health_check_url: parsed.health || undefined,
      app_url: parsed.app || undefined,
    });
    setIsEditingSnapshot(false);
  };

  const handleCancelSnapshot = () => {
    setSnapshotYamlText(prettyYaml(snapshotFromWorktree(worktree)));
    setSnapshotYamlError(null);
    setIsEditingSnapshot(false);
  };

  // ----- Import / export (admin only) -----
  const handleImport = () => {
    if (!client || !onUpdateRepo) return;
    const variantNamesToOverwrite = repo.environment ? Object.keys(repo.environment.variants) : [];
    confirm({
      title: 'Import .agor.yml?',
      icon: <DownloadOutlined />,
      content: (
        <div>
          <p>
            This will replace your repo-level variants with the contents of <code>.agor.yml</code>{' '}
            in this worktree.
          </p>
          {variantNamesToOverwrite.length > 0 && (
            <p style={{ marginBottom: 4 }}>
              Current variants that will be replaced:{' '}
              {variantNamesToOverwrite.map((n) => (
                <Tag key={n} style={{ marginBottom: 4 }}>
                  {n}
                </Tag>
              ))}
            </p>
          )}
          <p style={{ marginTop: 8 }}>
            Your <code>template_overrides</code> and worktree-level snapshots are preserved.
          </p>
        </div>
      ),
      okText: 'Import',
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          const updated = (await client
            .service(`repos/${repo.repo_id}/import-agor-yml`)
            .create({ worktree_id: worktree.worktree_id })) as Repo;
          if (updated.environment) {
            setRepoYamlText(prettyYaml(updated.environment));
          }
          onUpdateRepo(repo.repo_id, { environment: updated.environment });
          showSuccess('Imported .agor.yml');
        } catch (error) {
          showError(error instanceof Error ? error.message : 'Failed to import .agor.yml');
        }
      },
    });
  };

  const handleExport = () => {
    if (!client) return;
    confirm({
      title: 'Export to .agor.yml?',
      icon: <UploadOutlined />,
      content: (
        <div>
          <p>
            This will overwrite <code>.agor.yml</code> in the repo root (this worktree&apos;s
            working copy).
          </p>
          <p>
            <code>template_overrides</code> stays local and will not be written.
          </p>
        </div>
      ),
      okText: 'Export',
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          await client
            .service(`repos/${repo.repo_id}/export-agor-yml`)
            .create({ worktree_id: worktree.worktree_id });
          showSuccess('Environment configuration exported to .agor.yml');
        } catch (error) {
          showError(error instanceof Error ? error.message : 'Failed to export .agor.yml');
        }
      },
    });
  };

  // ----- Derived UI state -----
  const inferredState = getEnvironmentState(worktree.environment_instance);
  const hasEnvironmentConfig = !!repo.environment;
  const noVariantsConfigured = !hasEnvironmentConfig;

  // Read/edit exclusivity — only one editor active at a time.
  const repoEditBlocked = isEditingSnapshot;
  const snapshotEditBlocked = isEditingRepo;

  const repoDocsLink = (
    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
      <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">
        Documentation
      </a>
    </Typography.Text>
  );

  const statusBadge = useMemo(() => {
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
  }, [inferredState, token]);

  const healthIcon = lastHealthCheck ? (
    lastHealthCheck.status === 'healthy' ? (
      <CheckCircleOutlined style={{ color: token.colorSuccess }} />
    ) : lastHealthCheck.status === 'unhealthy' ? (
      <CloseCircleOutlined style={{ color: token.colorError }} />
    ) : (
      <WarningOutlined style={{ color: token.colorWarning }} />
    )
  ) : null;

  const variantSelectOptions = availableVariants.map((name) => {
    const variant = repo.environment?.variants[name];
    const description = variant?.description;
    const isDefault = repo.environment?.default === name;
    return {
      value: name,
      label: (
        <span>
          <strong>{name}</strong>
          {isDefault && (
            <Tag color="blue" style={{ marginLeft: 6, fontSize: 10 }}>
              default
            </Tag>
          )}
          {description && (
            <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 11 }}>
              {description}
            </Typography.Text>
          )}
        </span>
      ),
    };
  });

  // ----- Render -----
  return (
    <div style={{ width: '100%', maxHeight: '70vh', overflowY: 'auto' }}>
      <Space orientation="vertical" size="large" style={{ width: '100%' }}>
        {/* ====== Environment Controls (top — unchanged from prior behavior) ====== */}
        {hasEnvironmentConfig && (
          <Card size="small">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              {envStatus === 'running' && <Spin size="small" />}
              {healthIcon}
              {statusBadge}
              <div style={{ flex: 1 }} />

              <Button
                type="primary"
                size="small"
                icon={isStarting ? <LoadingOutlined /> : <PlayCircleOutlined />}
                onClick={handleStart}
                loading={isStarting}
                disabled={
                  !canTriggerEnv ||
                  envStatus === 'running' ||
                  envStatus === 'starting' ||
                  isStarting ||
                  isStopping ||
                  isRestarting
                }
                title={triggerDisabledTooltip}
              >
                Start
              </Button>
              <Button
                size="small"
                icon={isStopping ? <LoadingOutlined /> : <PoweroffOutlined />}
                onClick={handleStop}
                loading={isStopping}
                disabled={!canTriggerEnv}
                title={triggerDisabledTooltip}
                danger
              >
                Stop
              </Button>
              <Button
                size="small"
                icon={isRestarting ? <LoadingOutlined /> : <ReloadOutlined />}
                onClick={handleRestart}
                disabled={!canTriggerEnv || isStarting || isStopping || isRestarting}
                loading={isRestarting}
                title={triggerDisabledTooltip}
              >
                Restart
              </Button>
              {worktree.nuke_command && (
                <Button
                  size="small"
                  icon={isNuking ? <LoadingOutlined /> : <FireOutlined />}
                  onClick={handleNuke}
                  disabled={!canTriggerEnv || isStarting || isStopping || isRestarting || isNuking}
                  loading={isNuking}
                  danger
                  title={
                    triggerDisabledTooltip ??
                    'Nuke environment (destructive - removes all data and volumes)'
                  }
                >
                  Nuke
                </Button>
              )}
              <Button
                size="small"
                icon={<FileTextOutlined />}
                onClick={() => setLogsModalOpen(true)}
                disabled={!worktree.logs_command}
                title={
                  !worktree.logs_command
                    ? 'Configure a logs command in the variant to enable'
                    : undefined
                }
              >
                View Logs
              </Button>
            </div>

            {envStatus === 'error' && (lastHealthCheck?.message || lastError) && (
              <Alert
                style={{ marginTop: 12, fontSize: 11 }}
                type="error"
                showIcon
                title={lastHealthCheck?.message || 'Environment Error'}
                description={
                  lastError && (
                    <pre
                      style={{
                        maxHeight: 200,
                        overflow: 'auto',
                        margin: 0,
                        fontSize: 11,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {lastError}
                    </pre>
                  )
                }
              />
            )}
          </Card>
        )}

        {/* ====== Empty state (no variants configured) ====== */}
        {noVariantsConfigured && (
          <Alert
            type="info"
            showIcon
            title="No environment variants configured"
            description={
              <div>
                <p style={{ marginBottom: 8 }}>
                  {isAdmin
                    ? 'Import from an existing .agor.yml or add variants in the repo editor below.'
                    : 'Ask an admin to set up environment commands in the repo editor below.'}
                </p>
                {isAdmin && (
                  <Space>
                    <Button size="small" icon={<DownloadOutlined />} onClick={handleImport}>
                      Import from .agor.yml
                    </Button>
                  </Space>
                )}
                <div style={{ marginTop: 8 }}>
                  <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">
                    Documentation: environment variants
                  </a>
                </div>
              </div>
            }
          />
        )}

        {/* ====== Repo-level editor ====== */}
        <Card
          size="small"
          title={
            <Space>
              <CodeOutlined />
              <span>Repository environment (shared)</span>
              <Tag color="orange" style={{ fontSize: 10 }}>
                Affects all worktrees on this repo
              </Tag>
            </Space>
          }
          extra={
            <Space size="small">
              <Tooltip
                title={
                  isAdmin
                    ? 'Replace variants with contents of .agor.yml in this worktree'
                    : 'Only admins can import .agor.yml'
                }
              >
                <Button
                  type="text"
                  size="small"
                  icon={<DownloadOutlined />}
                  onClick={handleImport}
                  disabled={!isAdmin}
                >
                  Import
                </Button>
              </Tooltip>
              <Tooltip
                title={
                  !hasEnvironmentConfig
                    ? 'No configuration to export'
                    : !isAdmin
                      ? 'Only admins can export .agor.yml'
                      : 'Write variants + default to .agor.yml (template_overrides stripped)'
                }
              >
                <Button
                  type="text"
                  size="small"
                  icon={<UploadOutlined />}
                  onClick={handleExport}
                  disabled={!isAdmin || !hasEnvironmentConfig}
                >
                  Export
                </Button>
              </Tooltip>
              {!isEditingRepo && (
                <Tooltip
                  title={
                    !isAdmin
                      ? 'Only admins can edit repo environment'
                      : repoEditBlocked
                        ? 'Finish editing the worktree snapshot first'
                        : undefined
                  }
                >
                  <Button
                    type="text"
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => setIsEditingRepo(true)}
                    disabled={!isAdmin || repoEditBlocked}
                  >
                    Edit
                  </Button>
                </Tooltip>
              )}
            </Space>
          }
        >
          <Space orientation="vertical" size="small" style={{ width: '100%' }}>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              YAML representation of <code>repo.environment</code>. Includes <code>version</code>,{' '}
              <code>default</code>, <code>variants</code>, and optional{' '}
              <code>template_overrides</code>. {repoDocsLink}
            </Typography.Text>
            <CodeEditor
              value={repoYamlText}
              onChange={(v) => {
                setRepoYamlText(v);
                if (repoYamlError) setRepoYamlError(null);
              }}
              language="yaml"
              placeholder={
                noVariantsConfigured && isAdmin
                  ? 'version: 2\ndefault: lean\nvariants:\n  lean:\n    start: docker compose up -d\n    stop: docker compose down\n'
                  : ''
              }
              readOnly={!isEditingRepo}
              rows={14}
            />
            {repoYamlError && (
              <Alert type="error" showIcon title={`Invalid repo environment: ${repoYamlError}`} />
            )}
            {isEditingRepo && (
              <Space>
                <Button
                  type="primary"
                  size="small"
                  icon={<SaveOutlined />}
                  onClick={handleSaveRepo}
                >
                  Save
                </Button>
                <Button size="small" onClick={handleCancelRepo}>
                  Cancel
                </Button>
              </Space>
            )}
          </Space>
        </Card>

        {/* ====== Variant picker + Render button ====== */}
        <Card size="small">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Typography.Text strong style={{ fontSize: 13 }}>
              Variant:
            </Typography.Text>
            <Select
              value={selectedVariant || undefined}
              onChange={setSelectedVariant}
              style={{ minWidth: 260 }}
              size="small"
              options={variantSelectOptions}
              disabled={!hasEnvironmentConfig}
              placeholder={
                noVariantsConfigured ? 'No variants configured — ask an admin' : 'Select a variant'
              }
            />
            {variantChanged && (
              <Tag color="gold" style={{ fontSize: 10 }}>
                will replace snapshot
              </Tag>
            )}
            <div style={{ flex: 1 }} />
            <Tooltip title={renderDisabledTooltip}>
              <Button
                type="primary"
                size="small"
                icon={isRendering ? <LoadingOutlined /> : <ThunderboltOutlined />}
                onClick={handleRender}
                loading={isRendering}
                disabled={renderDisabled}
              >
                Render
              </Button>
            </Tooltip>
          </div>
        </Card>

        {/* ====== Worktree snapshot editor ====== */}
        <Card
          size="small"
          title={
            <Space>
              <PlayCircleOutlined />
              <span>Worktree environment: {worktree.name}</span>
              {worktree.environment_variant && (
                <Tag color="blue" style={{ fontSize: 10 }}>
                  rendered from: {worktree.environment_variant}
                </Tag>
              )}
            </Space>
          }
          extra={
            !isEditingSnapshot && (
              <Tooltip
                title={
                  !isAdmin
                    ? 'Only admins can edit the rendered snapshot directly'
                    : snapshotEditBlocked
                      ? 'Finish editing the repo environment first'
                      : 'Edit the rendered commands for this worktree only'
                }
              >
                <Button
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => setIsEditingSnapshot(true)}
                  disabled={!isAdmin || snapshotEditBlocked}
                >
                  Edit
                </Button>
              </Tooltip>
            )
          }
        >
          <Space orientation="vertical" size="small" style={{ width: '100%' }}>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              Rendered snapshot persisted on this worktree (fields: <code>start</code>,{' '}
              <code>stop</code>, <code>nuke</code>, <code>logs</code>, <code>health</code>,{' '}
              <code>app</code>). Click Render above to regenerate from the variant.
            </Typography.Text>
            <CodeEditor
              value={snapshotYamlText}
              onChange={(v) => {
                setSnapshotYamlText(v);
                if (snapshotYamlError) setSnapshotYamlError(null);
              }}
              language="yaml"
              readOnly={!isEditingSnapshot}
              rows={10}
            />
            {snapshotYamlError && (
              <Alert type="error" showIcon title={`Invalid snapshot: ${snapshotYamlError}`} />
            )}
            {isEditingSnapshot && (
              <Space>
                <Button
                  type="primary"
                  size="small"
                  icon={<SaveOutlined />}
                  onClick={handleSaveSnapshot}
                >
                  Save
                </Button>
                <Button size="small" onClick={handleCancelSnapshot}>
                  Cancel
                </Button>
              </Space>
            )}
          </Space>
        </Card>
      </Space>

      <EnvironmentLogsModal
        open={logsModalOpen}
        onClose={() => setLogsModalOpen(false)}
        worktree={worktree}
        client={client}
      />
    </div>
  );
};
