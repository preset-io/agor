import { resolveRepoCleanupPolicy } from '@agor/core/types';
import type { CreateLocalRepoRequest, CreateRepoRequest, Repo } from '@agor-live/client';
import { DeleteOutlined, EditOutlined, FolderOutlined, PlusOutlined } from '@ant-design/icons';
import type { RadioChangeEvent } from 'antd';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Empty,
  Form,
  Input,
  Modal,
  Space,
  Tooltip,
  Typography,
} from 'antd';
import {
  type Key,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAuthorityOperationGuard } from '@/hooks/useAuthorityOperationGuard';
import { mapToArray } from '@/utils/mapHelpers';
import { repositorySetupMessage } from '@/utils/repositorySetupMessage';
import { filterBySettingsSearch } from '@/utils/settingsSearch';
import { RepoFormFields } from '../forms/RepoFormFields';
import { HighlightMatch } from '../HighlightMatch';
import { Tag } from '../Tag';
import { ResponsiveSettingsHeader } from './ResponsiveSettingsHeader';
import { ResponsiveTable } from './ResponsiveTable';
import { SettingsActionGroup } from './SettingsActionGroup';
import { DrillInFrame, useDrillFormDraft, useSettingsDrill } from './SettingsDrill';

interface ReposTableProps {
  repoById: Map<string, Repo>;
  /** Whether the caller may configure the branch cleanup policy (admin-only). */
  canConfigureCleanup?: boolean;
  identityKey: string | null;
  operationScope: readonly unknown[] | null;
  onCreate?: (data: CreateRepoRequest, shouldApply?: () => boolean) => unknown;
  onCreateLocal?: (
    data: CreateLocalRepoRequest,
    shouldApply?: () => boolean
  ) => void | Promise<void>;
  onUpdate?: (
    repoId: string,
    updates: Partial<Repo>,
    shouldApply?: () => boolean
  ) => void | Promise<void>;
  onDelete?: (
    repoId: string,
    cleanup: boolean,
    shouldApply?: () => boolean
  ) => void | Promise<void>;
}

export const ReposTable: React.FC<ReposTableProps> = ({
  repoById,
  canConfigureCleanup = false,
  identityKey,
  operationScope,
  onCreate,
  onCreateLocal,
  onUpdate,
  onDelete,
}) => {
  const repos = useMemo(
    () => mapToArray(repoById).sort((a, b) => a.name.localeCompare(b.name)),
    [repoById]
  );
  const [searchTerm, setSearchTerm] = useState('');
  const [repoMode, setRepoMode] = useState<'remote' | 'local'>('remote');
  const [repoForm] = Form.useForm();
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [repoToDelete, setRepoToDelete] = useState<Repo | null>(null);

  const { drill, openDrill, closeDrill } = useSettingsDrill();
  const operationGuard = useAuthorityOperationGuard(operationScope);

  // A different caller erases the selected caller-private row and any draft.
  const authorityKeyRef = useRef(identityKey);
  useLayoutEffect(() => {
    if (authorityKeyRef.current === identityKey) return;
    authorityKeyRef.current = identityKey;
    repoForm.resetFields();
    setRepoMode('remote');
    setDeleteModalOpen(false);
    setRepoToDelete(null);
    closeDrill();
  }, [identityKey, repoForm, closeDrill]);

  // Editing/creating swaps this section's Content pane for the drill-in editor
  // below, instead of stacking a second Modal on top of Settings.
  const editingRepo =
    drill?.mode === 'edit' && drill.recordId ? (repoById.get(drill.recordId) ?? null) : null;
  const isCreating = drill?.mode === 'create';
  const isEditing = !!editingRepo;

  const openEdit = useCallback(
    (repo: Repo) => openDrill({ mode: 'edit', recordId: repo.repo_id }),
    [openDrill]
  );
  const openCreate = useCallback(() => openDrill({ mode: 'create' }), [openDrill]);

  const filteredRepos = useMemo(
    () =>
      filterBySettingsSearch(repos, searchTerm, [
        (repo) => repo.name,
        (repo) => repo.slug,
        (repo) => repo.remote_url,
        (repo) => repo.local_path,
        (repo) => repo.default_branch,
        (repo) => repo.repo_type,
      ]),
    [repos, searchTerm]
  );

  useEffect(() => {
    if (editingRepo) setRepoMode(editingRepo.repo_type ?? 'remote');
  }, [editingRepo]);

  // Reset the form to create defaults (remote mode, default_branch "main")
  // whenever the drill-in enters create mode.
  useEffect(() => {
    if (isCreating) {
      setRepoMode('remote');
      repoForm.resetFields();
      repoForm.setFieldsValue({ default_branch: 'main' });
    }
  }, [isCreating, repoForm]);
  // Seeds an opened repo once; later record updates never overwrite the draft.
  const isDraftDirty = useDrillFormDraft(
    repoForm,
    drill,
    useMemo(
      () =>
        editingRepo && {
          slug: editingRepo.slug,
          default_branch: editingRepo.default_branch || 'main',
          cleanup_policy: resolveRepoCleanupPolicy(editingRepo.cleanup_policy),
        },
      [editingRepo]
    )
  );

  const handleOpenDeleteModal = (repo: Repo) => {
    setRepoToDelete(repo);
    setDeleteModalOpen(true);
  };

  const handleConfirmDelete = async (cleanup: boolean) => {
    const operation = operationGuard.begin();
    if (repoToDelete && operation.isCurrent()) {
      await onDelete?.(repoToDelete.repo_id, cleanup, operation.isCurrent);
      if (!operation.isCurrent()) return;
      setDeleteModalOpen(false);
      setRepoToDelete(null);
    }
  };

  const handleSave = useCallback(async () => {
    const operation = operationGuard.begin();
    if (!operation.isCurrent()) return;
    try {
      const values = await repoForm.validateFields();
      if (!operation.isCurrent()) return;
      if (isEditing && editingRepo) {
        // Patch only what this draft changed since it was seeded, so a
        // concurrent edit to an untouched field survives. Metadata-only saves
        // must not require executable-config authority; changed policy keys go
        // over the live policy, keeping an administrator's concurrent edits.
        const changed = isDraftDirty.changedValues();
        const updates: Partial<Repo> = {};
        if ('slug' in changed) updates.slug = values.slug;
        if ('default_branch' in changed && values.default_branch) {
          updates.default_branch = values.default_branch;
        }
        const policyChanges = changed.cleanup_policy as
          | Partial<ReturnType<typeof resolveRepoCleanupPolicy>>
          | undefined;
        if (canConfigureCleanup && policyChanges && Object.keys(policyChanges).length > 0) {
          updates.cleanup_policy = {
            ...resolveRepoCleanupPolicy(editingRepo.cleanup_policy),
            ...policyChanges,
          };
        }
        if (Object.keys(updates).length > 0) {
          await onUpdate?.(editingRepo.repo_id, updates, operation.isCurrent);
        }
      } else if (repoMode === 'local') {
        await onCreateLocal?.(
          { path: values.path, slug: values.slug || undefined },
          operation.isCurrent
        );
      } else {
        await onCreate?.(
          {
            url: values.url,
            slug: values.slug,
            default_branch: values.default_branch,
          },
          operation.isCurrent
        );
      }
      if (!operation.isCurrent()) return;
      closeDrill();
    } catch {
      // Ant Design displays validation errors. Parent mutation errors already
      // own their user-facing message; either way stale continuations do not
      // close or clear a reconnect-preserved draft.
    }
  }, [
    operationGuard,
    repoForm,
    isEditing,
    editingRepo,
    repoMode,
    canConfigureCleanup,
    isDraftDirty,
    onUpdate,
    onCreateLocal,
    onCreate,
    closeDrill,
  ]);

  const handleModeChange = (e: RadioChangeEvent) => {
    const value = e.target.value as 'remote' | 'local';
    setRepoMode(value);
    repoForm.resetFields();
    repoForm.setFieldsValue({
      url: undefined,
      path: undefined,
      slug: undefined,
      default_branch: value === 'remote' ? 'main' : undefined,
    });
  };

  const drillTitle = isEditing
    ? 'Edit Repository'
    : repoMode === 'local'
      ? 'Add Local Repository'
      : 'Clone Repository';
  const drillSaveLabel = isEditing ? 'Save' : repoMode === 'local' ? 'Add' : 'Clone';

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      width: 220,
      render: (name: string, repo: Repo) => (
        <Space>
          <FolderOutlined />
          <Typography.Link ellipsis title={name} onClick={() => openEdit(repo)}>
            <HighlightMatch text={name} query={searchTerm} />
          </Typography.Link>
          <Tooltip
            title={
              repo.clone_status === 'cloning' || repo.clone_status === 'failed'
                ? repositorySetupMessage(repo)
                : undefined
            }
          >
            <Tag
              color={
                repo.clone_status === 'failed'
                  ? 'warning'
                  : repo.clone_status === 'cloning'
                    ? 'processing'
                    : 'success'
              }
            >
              {repo.clone_status === 'failed'
                ? 'Failed'
                : repo.clone_status === 'cloning'
                  ? 'Cloning'
                  : 'Ready'}
            </Tag>
          </Tooltip>
        </Space>
      ),
    },
    {
      title: 'Type',
      dataIndex: 'repo_type',
      key: 'repo_type',
      width: 100,
      filters: [
        { text: 'Remote', value: 'remote' },
        { text: 'Local', value: 'local' },
      ],
      onFilter: (value: Key | boolean, repo: Repo) => (repo.repo_type ?? 'remote') === value,
      render: (_: unknown, repo: Repo) => {
        const isLocal = repo.repo_type === 'local';
        return <Tag color={isLocal ? 'green' : 'blue'}>{isLocal ? 'Local' : 'Remote'}</Tag>;
      },
    },
    {
      title: 'Slug',
      dataIndex: 'slug',
      key: 'slug',
      width: 200,
      render: (slug: string) => (
        <Typography.Text code style={{ fontSize: 12 }}>
          <HighlightMatch text={slug} query={searchTerm} />
        </Typography.Text>
      ),
    },
    {
      title: 'Location',
      key: 'location',
      render: (_: unknown, repo: Repo) => {
        const location = repo.remote_url || repo.local_path;
        return location ? (
          <Typography.Text code ellipsis style={{ fontSize: 11 }} title={location}>
            <HighlightMatch text={location} query={searchTerm} />
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        );
      },
    },
    {
      title: 'Branch',
      dataIndex: 'default_branch',
      key: 'default_branch',
      width: 120,
      render: (branch?: string) =>
        branch ? (
          <Typography.Text code style={{ fontSize: 11 }}>
            <HighlightMatch text={branch} query={searchTerm} />
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 88,
      render: (_: unknown, repo: Repo) => (
        <SettingsActionGroup>
          <Tooltip title="Edit repository">
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={() => openEdit(repo)}
            />
          </Tooltip>
          <Tooltip title="Delete repository">
            <Button
              type="text"
              size="small"
              icon={<DeleteOutlined />}
              danger
              onClick={() => handleOpenDeleteModal(repo)}
            />
          </Tooltip>
        </SettingsActionGroup>
      ),
    },
  ];

  if (editingRepo || isCreating) {
    return (
      <DrillInFrame
        title={drillTitle}
        dirty={isDraftDirty}
        saveLabel={drillSaveLabel}
        onSave={handleSave}
      >
        {editingRepo && (
          <RepoSetupStatus
            repo={editingRepo}
            onRetry={
              onCreate
                ? async (data) => {
                    const operation = operationGuard.begin();
                    if (!operation.isCurrent()) return;
                    try {
                      await onCreate(data, operation.isCurrent);
                    } catch {
                      // The explicit create handler owns the actionable notification.
                    }
                  }
                : undefined
            }
          />
        )}
        <Form form={repoForm} layout="vertical" style={{ maxWidth: 520 }}>
          <RepoFormFields
            form={repoForm}
            mode={isEditing ? 'edit' : 'create'}
            repoMode={repoMode}
            onRepoModeChange={handleModeChange}
            canConfigureCleanup={canConfigureCleanup}
          />
        </Form>
      </DrillInFrame>
    );
  }

  return (
    <div>
      <ResponsiveSettingsHeader
        title="Repositories"
        description="Connect remote or local git repositories for your sessions."
        search={
          <Input
            allowClear
            placeholder="Search name, slug, URL, path, type, or branch"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />
        }
        primaryActions={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            New Repository
          </Button>
        }
      />

      {repos.length === 0 ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 400,
          }}
        >
          <Empty description="No repositories yet">
            <Typography.Text type="secondary">
              Click "New Repository" to clone a remote repo or switch to "Local" mode to link an
              existing clone. You can also run <code>agor local add-repo &lt;path&gt;</code> from
              the CLI.
            </Typography.Text>
          </Empty>
        </div>
      ) : filteredRepos.length === 0 ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 400,
          }}
        >
          <Empty description={`No repositories match “${searchTerm}”`} />
        </div>
      ) : (
        <ResponsiveTable
          primaryColumnKey="name"
          dataSource={filteredRepos}
          columns={columns}
          rowKey="repo_id"
          pagination={{ pageSize: 10, showSizeChanger: true }}
          size="small"
        />
      )}

      {/* Delete Repository Modal */}
      <Modal
        title="Delete Repository"
        open={deleteModalOpen}
        onCancel={() => {
          setDeleteModalOpen(false);
          setRepoToDelete(null);
        }}
        footer={null}
      >
        {repoToDelete && (
          <Space orientation="vertical" size={16} style={{ width: '100%' }}>
            <Typography.Text>
              How would you like to delete{' '}
              <Typography.Text strong>"{repoToDelete.name}"</Typography.Text>?
            </Typography.Text>

            {repoToDelete.repo_type === 'local' ? (
              <Card style={{ marginBottom: 8 }} styles={{ body: { padding: 16 } }}>
                <Space orientation="vertical" size={8} style={{ width: '100%' }}>
                  <Typography.Text strong>Remove from Agor</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Remove this repository from Agor's database only. Your local files at{' '}
                    <Typography.Text code>{repoToDelete.local_path}</Typography.Text> will remain
                    untouched.
                  </Typography.Text>
                  <Button
                    danger
                    onClick={() => handleConfirmDelete(false)}
                    style={{ marginTop: 8 }}
                  >
                    Remove from Agor
                  </Button>
                </Space>
              </Card>
            ) : (
              <>
                <Card style={{ marginBottom: 8 }} styles={{ body: { padding: 16 } }}>
                  <Space orientation="vertical" size={8} style={{ width: '100%' }}>
                    <Typography.Text strong>Remove from Agor (Keep Files)</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      Remove from database only. Repository and branch directories in{' '}
                      <Typography.Text code>~/.agor/repos/</Typography.Text> and{' '}
                      <Typography.Text code>~/.agor/worktrees/</Typography.Text> will remain on
                      disk.
                    </Typography.Text>
                    <Button onClick={() => handleConfirmDelete(false)} style={{ marginTop: 8 }}>
                      Keep Files
                    </Button>
                  </Space>
                </Card>

                <Card styles={{ body: { padding: 16 } }}>
                  <Space orientation="vertical" size={8} style={{ width: '100%' }}>
                    <Typography.Text strong>Delete Completely (Remove Files)</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      ⚠️ Remove from database AND delete all filesystem directories (repository +
                      branches). This will free up disk space but cannot be undone.
                    </Typography.Text>
                    <Button
                      danger
                      onClick={() => handleConfirmDelete(true)}
                      style={{ marginTop: 8 }}
                    >
                      Delete Files
                    </Button>
                  </Space>
                </Card>
              </>
            )}
          </Space>
        )}
      </Modal>
    </div>
  );
};

/** Setup progress / failure for a repository, with a retry for a failed remote clone. */
const RepoSetupStatus: React.FC<{
  repo: Repo;
  onRetry?: (data: CreateRepoRequest) => void;
}> = ({ repo, onRetry }) => {
  if (repo.clone_status !== 'cloning' && repo.clone_status !== 'failed') return null;
  const remoteUrl = repo.remote_url;
  return (
    <Space
      orientation="vertical"
      size={8}
      style={{ width: '100%', maxWidth: 520, marginBottom: 16 }}
    >
      <Alert
        type={repo.clone_status === 'failed' ? 'warning' : 'info'}
        showIcon
        title={
          repo.clone_status === 'failed'
            ? 'Repository setup failed'
            : 'Repository setup in progress'
        }
        description={repositorySetupMessage(repo)}
        action={
          repo.clone_status === 'failed' && remoteUrl && onRetry ? (
            <Button
              size="small"
              onClick={() =>
                onRetry({
                  url: remoteUrl,
                  slug: repo.slug,
                  default_branch: repo.default_branch || 'main',
                })
              }
            >
              Retry setup
            </Button>
          ) : undefined
        }
      />
      {repo.clone_status === 'failed' && repo.clone_error && (
        <Collapse
          size="small"
          items={[
            {
              key: 'setup',
              label: 'Setup diagnostics',
              children: (
                <>
                  <Typography.Paragraph>
                    Attempt {repo.clone_generation ?? 'legacy'} · {repo.clone_error.category} · exit{' '}
                    {repo.clone_error.exit_code}
                  </Typography.Paragraph>
                  <Typography.Paragraph code>
                    {repo.clone_error.message.slice(0, 2000)}
                  </Typography.Paragraph>
                </>
              ),
            },
          ]}
        />
      )}
    </Space>
  );
};
