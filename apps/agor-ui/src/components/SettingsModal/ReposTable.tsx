import type { CreateLocalRepoRequest, CreateRepoRequest, Repo } from '@agor-live/client';
import { DeleteOutlined, EditOutlined, FolderOutlined, PlusOutlined } from '@ant-design/icons';
import type { RadioChangeEvent } from 'antd';
import { Button, Card, Empty, Form, Modal, Space, Typography } from 'antd';
import { useState } from 'react';
import { mapToArray } from '@/utils/mapHelpers';
import { RepoFormFields } from '../forms/RepoFormFields';
import { Tag } from '../Tag';

interface ReposTableProps {
  repoById: Map<string, Repo>;
  onCreate?: (data: CreateRepoRequest) => void;
  onCreateLocal?: (data: CreateLocalRepoRequest) => void;
  onUpdate?: (repoId: string, updates: Partial<Repo>) => void;
  onDelete?: (repoId: string, cleanup: boolean) => void;
}

export const ReposTable: React.FC<ReposTableProps> = ({
  repoById,
  onCreate,
  onCreateLocal,
  onUpdate,
  onDelete,
}) => {
  const repos = mapToArray(repoById).sort((a, b) => a.name.localeCompare(b.name));
  const [repoModalOpen, setRepoModalOpen] = useState(false);
  const [editingRepo, setEditingRepo] = useState<Repo | null>(null);
  const [repoMode, setRepoMode] = useState<'remote' | 'local'>('remote');
  const [repoForm] = Form.useForm();
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [repoToDelete, setRepoToDelete] = useState<Repo | null>(null);

  const isEditing = !!editingRepo;

  const handleOpenDeleteModal = (repo: Repo) => {
    setRepoToDelete(repo);
    setDeleteModalOpen(true);
  };

  const handleConfirmDelete = (cleanup: boolean) => {
    if (repoToDelete) {
      onDelete?.(repoToDelete.repo_id, cleanup);
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

  const handleSaveRepo = () => {
    repoForm.validateFields().then((values) => {
      if (isEditing && editingRepo) {
        const updates: Partial<Repo> = {
          slug: values.slug,
        };
        if (values.default_branch) {
          updates.default_branch = values.default_branch;
        }
        onUpdate?.(editingRepo.repo_id, updates);
      } else {
        if (repoMode === 'local') {
          onCreateLocal?.({
            path: values.path,
            slug: values.slug || undefined,
          });
        } else {
          onCreate?.({
            url: values.url,
            slug: values.slug,
            default_branch: values.default_branch,
          });
        }
      }
      repoForm.resetFields();
      setEditingRepo(null);
      setRepoModalOpen(false);
    });
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
      <div
        style={{
          marginBottom: 16,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Typography.Text type="secondary">
          Connect remote or local git repositories for your sessions.
        </Typography.Text>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleOpenCreateModal}>
          New Repository
        </Button>
      </div>

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
              existing clone. You can also run <code>agor repo add-local &lt;path&gt;</code> from
              the CLI.
            </Typography.Text>
          </Empty>
        </div>
      )}

      {repos.length > 0 && (
        <Space orientation="vertical" size={16} style={{ width: '100%' }}>
          {repos.map((repo: Repo) => {
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
                    <Typography.Text strong>{repo.name}</Typography.Text>
                    <Tag color={tagColor} style={{ marginLeft: 8 }}>
                      {tagLabel}
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
                      {repo.slug}
                    </Typography.Text>
                  </div>

                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      Type:{' '}
                    </Typography.Text>
                    <Typography.Text code style={{ fontSize: 11 }}>
                      {tagLabel.toLowerCase()}
                    </Typography.Text>
                  </div>

                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      Remote:{' '}
                    </Typography.Text>
                    <Typography.Text code style={{ fontSize: 11 }}>
                      {repo.remote_url ?? '—'}
                    </Typography.Text>
                  </div>

                  {repo.local_path && (
                    <div>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        Path:{' '}
                      </Typography.Text>
                      <Typography.Text code style={{ fontSize: 11 }}>
                        {repo.local_path}
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
      <Modal
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
      </Modal>

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
                      Remove from database only. Repository and worktree directories in{' '}
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
                      worktrees). This will free up disk space but cannot be undone.
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
