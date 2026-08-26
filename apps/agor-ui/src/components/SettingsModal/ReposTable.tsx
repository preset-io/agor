import type { CreateLocalRepoRequest, CreateRepoRequest, Repo } from '@agor-live/client';
import { DeleteOutlined, EditOutlined, FolderOutlined, PlusOutlined } from '@ant-design/icons';
import type { RadioChangeEvent } from 'antd';
import { Button, Card, Empty, Form, Input, Space, Typography } from 'antd';
import { useLayoutEffect, useMemo, useState } from 'react';
import { useAuthorityOperationGuard } from '@/hooks/useAuthorityOperationGuard';
import { mapToArray } from '@/utils/mapHelpers';
import { filterBySettingsSearch } from '@/utils/settingsSearch';
import { RepoFormFields } from '../forms/RepoFormFields';
import { HighlightMatch } from '../HighlightMatch';
import { Tag } from '../Tag';
import { AdaptiveSettingsModal } from './AdaptiveSettingsModal';
import { ResponsiveSettingsHeader } from './ResponsiveSettingsHeader';

interface ReposTableProps {
  repoById: Map<string, Repo>;
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
  const [repoModalOpen, setRepoModalOpen] = useState(false);
  const [editingRepo, setEditingRepo] = useState<Repo | null>(null);
  const [repoMode, setRepoMode] = useState<'remote' | 'local'>('remote');
  const [repoForm] = Form.useForm();
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [repoToDelete, setRepoToDelete] = useState<Repo | null>(null);
  const operationGuard = useAuthorityOperationGuard(operationScope);

  // biome-ignore lint/correctness/useExhaustiveDependencies: authorityKey intentionally erases the selected caller-private row
  useLayoutEffect(() => {
    repoForm.resetFields();
    setRepoModalOpen(false);
    setEditingRepo(null);
    setRepoMode('remote');
    setDeleteModalOpen(false);
    setRepoToDelete(null);
  }, [identityKey, repoForm]);

  const isEditing = !!editingRepo;
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

  const handleOpenCreateModal = () => {
    setEditingRepo(null);
    setRepoMode('remote');
    repoForm.resetFields();
    repoForm.setFieldsValue({
      default_branch: 'main',
    });
    setRepoModalOpen(true);
  };

  const handleOpenEditModal = (repo: Repo) => {
    setEditingRepo(repo);
    setRepoMode(repo.repo_type ?? 'remote');
    repoForm.setFieldsValue({
      slug: repo.slug,
      default_branch: repo.default_branch || 'main',
    });
    setRepoModalOpen(true);
  };

  const handleSaveRepo = async () => {
    const operation = operationGuard.begin();
    if (!operation.isCurrent()) return;
    try {
      const values = await repoForm.validateFields();
      if (!operation.isCurrent()) return;
      if (isEditing && editingRepo) {
        const updates: Partial<Repo> = {
          slug: values.slug,
        };
        if (values.default_branch) {
          updates.default_branch = values.default_branch;
        }
        await onUpdate?.(editingRepo.repo_id, updates, operation.isCurrent);
      } else {
        if (repoMode === 'local') {
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
      }
      if (!operation.isCurrent()) return;
      repoForm.resetFields();
      setEditingRepo(null);
      setRepoModalOpen(false);
    } catch {
      // Ant Design displays validation errors. Parent mutation errors already
      // own their user-facing message; either way stale continuations do not
      // close or clear a reconnect-preserved draft.
    }
  };

  const handleCancelModal = () => {
    repoForm.resetFields();
    setEditingRepo(null);
    setRepoMode('remote');
    setRepoModalOpen(false);
  };

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

  const modalTitle = isEditing
    ? 'Edit Repository'
    : repoMode === 'local'
      ? 'Add Local Repository'
      : 'Clone Repository';
  const modalOkText = isEditing ? 'Save' : repoMode === 'local' ? 'Add' : 'Clone';

  return (
    <div>
      <ResponsiveSettingsHeader
        description="Connect remote or local git repositories for your sessions."
        actions={(compact) => (
          <Space wrap style={{ width: compact ? '100%' : undefined }}>
            <Input
              allowClear
              placeholder="Search name, slug, URL, path, type, or branch"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              style={{ width: compact ? '100%' : 340, flex: compact ? '1 1 100%' : undefined }}
            />
            <Button type="primary" icon={<PlusOutlined />} onClick={handleOpenCreateModal}>
              New Repository
            </Button>
          </Space>
        )}
      />

      {repos.length === 0 && (
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
      )}

      {repos.length > 0 && (
        <Space orientation="vertical" size={16} style={{ width: '100%' }}>
          {filteredRepos.map((repo: Repo) => {
            const isLocal = repo.repo_type === 'local';
            const tagColor = isLocal ? 'green' : 'blue';
            const tagLabel = isLocal ? 'Local' : 'Remote';

            return (
              <Card
                key={repo.repo_id}
                size="small"
                title={
                  <Space>
                    <FolderOutlined />
                    <Typography.Text strong>
                      <HighlightMatch text={repo.name} query={searchTerm} />
                    </Typography.Text>
                    <Tag color={tagColor} style={{ marginLeft: 8 }}>
                      <HighlightMatch text={tagLabel} query={searchTerm} />
                    </Tag>
                  </Space>
                }
                extra={
                  <Space>
                    <Button
                      type="text"
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => handleOpenEditModal(repo)}
                    />
                    <Button
                      type="text"
                      size="small"
                      icon={<DeleteOutlined />}
                      danger
                      onClick={() => handleOpenDeleteModal(repo)}
                    />
                  </Space>
                }
              >
                {/* Repo metadata */}
                <Space orientation="vertical" size={8} style={{ width: '100%' }}>
                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      Slug:{' '}
                    </Typography.Text>
                    <Typography.Text code style={{ fontSize: 12 }}>
                      <HighlightMatch text={repo.slug} query={searchTerm} />
                    </Typography.Text>
                  </div>

                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      Type:{' '}
                    </Typography.Text>
                    <Typography.Text code style={{ fontSize: 11 }}>
                      <HighlightMatch text={tagLabel.toLowerCase()} query={searchTerm} />
                    </Typography.Text>
                  </div>

                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      Remote:{' '}
                    </Typography.Text>
                    <Typography.Text code style={{ fontSize: 11 }}>
                      {repo.remote_url ? (
                        <HighlightMatch text={repo.remote_url} query={searchTerm} />
                      ) : (
                        '—'
                      )}
                    </Typography.Text>
                  </div>

                  {repo.local_path && (
                    <div>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        Path:{' '}
                      </Typography.Text>
                      <Typography.Text code style={{ fontSize: 11 }}>
                        <HighlightMatch text={repo.local_path} query={searchTerm} />
                      </Typography.Text>
                    </div>
                  )}
                </Space>
              </Card>
            );
          })}
        </Space>
      )}

      {/* Create/Edit Repository Modal */}
      <AdaptiveSettingsModal
        title={modalTitle}
        open={repoModalOpen}
        onOk={handleSaveRepo}
        onCancel={handleCancelModal}
        okText={modalOkText}
      >
        <Form form={repoForm} layout="vertical" style={{ marginTop: 16 }}>
          <RepoFormFields
            form={repoForm}
            mode={isEditing ? 'edit' : 'create'}
            repoMode={repoMode}
            onRepoModeChange={handleModeChange}
          />
        </Form>
      </AdaptiveSettingsModal>

      {/* Delete Repository Modal */}
      <AdaptiveSettingsModal
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
      </AdaptiveSettingsModal>
    </div>
  );
};
