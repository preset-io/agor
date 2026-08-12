import type { CreateLocalRepoRequest, CreateRepoRequest, Repo } from '@agor-live/client';
import { DeleteOutlined, EditOutlined, FolderOutlined, PlusOutlined } from '@ant-design/icons';
import type { RadioChangeEvent } from 'antd';
import { Button, Card, Empty, Form, Input, Modal, Space, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { mapToArray } from '@/utils/mapHelpers';
import { filterBySettingsSearch } from '@/utils/settingsSearch';
import { RepoFormFields } from '../forms/RepoFormFields';
import { HighlightMatch } from '../HighlightMatch';
import { Tag } from '../Tag';
import { DrillInFrame, useSettingsDrill } from './SettingsDrill';

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
  const repos = useMemo(
    () => mapToArray(repoById).sort((a, b) => a.name.localeCompare(b.name)),
    [repoById]
  );
  const [searchTerm, setSearchTerm] = useState('');
  const [repoMode, setRepoMode] = useState<'remote' | 'local'>('remote');
  const [dirty, setDirty] = useState(false);
  const [repoForm] = Form.useForm();
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [repoToDelete, setRepoToDelete] = useState<Repo | null>(null);

  const { drill, openDrill, closeDrill } = useSettingsDrill();

  // Editing/creating swaps this section's Content pane for the drill-in editor
  // below, instead of stacking a second Modal on top of Settings.
  const editingRepo =
    drill?.kind === 'repos' && drill.mode === 'edit' && drill.recordId
      ? (repoById.get(drill.recordId) ?? null)
      : null;
  const isCreating = drill?.kind === 'repos' && drill.mode === 'create';
  const isEditing = !!editingRepo;

  const openEdit = useCallback(
    (repo: Repo) => openDrill({ kind: 'repos', mode: 'edit', recordId: repo.repo_id }),
    [openDrill]
  );
  const openCreate = useCallback(() => openDrill({ kind: 'repos', mode: 'create' }), [openDrill]);

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

  // Seed the form + mode whenever the drill-in targets an existing repo.
  useEffect(() => {
    if (editingRepo) {
      setRepoMode(editingRepo.repo_type ?? 'remote');
      repoForm.setFieldsValue({
        slug: editingRepo.slug,
        default_branch: editingRepo.default_branch || 'main',
      });
      setDirty(false);
    }
  }, [editingRepo, repoForm]);

  // Reset the form to create defaults (remote mode, default_branch "main")
  // whenever the drill-in enters create mode.
  useEffect(() => {
    if (isCreating) {
      setRepoMode('remote');
      repoForm.resetFields();
      repoForm.setFieldsValue({ default_branch: 'main' });
      setDirty(false);
    }
  }, [isCreating, repoForm]);

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

  const handleSave = useCallback(async () => {
    const values = await repoForm.validateFields();
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
    setDirty(false);
    closeDrill();
  }, [repoForm, isEditing, editingRepo, repoMode, onUpdate, onCreateLocal, onCreate, closeDrill]);

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
    setDirty(true);
  };

  const drillTitle = isEditing
    ? 'Edit Repository'
    : repoMode === 'local'
      ? 'Add Local Repository'
      : 'Clone Repository';
  const drillSaveLabel = isEditing ? 'Save' : repoMode === 'local' ? 'Add' : 'Clone';

  if (editingRepo || isCreating) {
    return (
      <DrillInFrame title={drillTitle} dirty={dirty} saveLabel={drillSaveLabel} onSave={handleSave}>
        <Form
          form={repoForm}
          layout="vertical"
          style={{ maxWidth: 520 }}
          onValuesChange={() => setDirty(true)}
        >
          <RepoFormFields
            form={repoForm}
            mode={isEditing ? 'edit' : 'create'}
            repoMode={repoMode}
            onRepoModeChange={handleModeChange}
          />
        </Form>
      </DrillInFrame>
    );
  }

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
        <Space>
          <Input
            allowClear
            placeholder="Search name, slug, URL, path, type, or branch"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            style={{ width: 340 }}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            New Repository
          </Button>
        </Space>
      </div>

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
              existing clone. You can also run <code>agor repo add-local &lt;path&gt;</code> from
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
                    <Typography.Link ellipsis title={repo.name} onClick={() => openEdit(repo)}>
                      <HighlightMatch text={repo.name} query={searchTerm} />
                    </Typography.Link>
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
                      onClick={() => openEdit(repo)}
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
