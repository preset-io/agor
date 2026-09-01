import type { CreateLocalRepoRequest, CreateRepoRequest, Repo } from '@agor-live/client';
import { DeleteOutlined, EditOutlined, FolderOutlined, PlusOutlined } from '@ant-design/icons';
import type { RadioChangeEvent } from 'antd';
import { Button, Card, Empty, Form, Input, Modal, Space, Table, Tooltip, Typography } from 'antd';
import { type Key, useCallback, useEffect, useMemo, useState } from 'react';
import { mapToArray } from '@/utils/mapHelpers';
import { filterBySettingsSearch } from '@/utils/settingsSearch';
import { RepoFormFields } from '../forms/RepoFormFields';
import { HighlightMatch } from '../HighlightMatch';
import { Tag } from '../Tag';
import { ListPanelHeader } from './panelPrimitives';
import { SettingsActionGroup } from './SettingsActionGroup';
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
      <ListPanelHeader
        title="Repositories"
        description="Connect remote or local git repositories for your sessions."
        search={
          <Input
            allowClear
            placeholder="Search name, slug, URL, path, type, or branch"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            style={{ width: 340 }}
          />
        }
        actions={
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
        <Table
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
