import type { Board, Repo, Session, Worktree } from '@agor/core/types';
import { isPersistedAgent } from '@agor/core/types';
import {
  BranchesOutlined,
  CodeSandboxOutlined,
  DeleteOutlined,
  DropboxOutlined,
  EditOutlined,
  FolderOutlined,
  PlusOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import {
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { mapToArray } from '@/utils/mapHelpers';
import { ArchiveDeleteWorktreeModal } from '../ArchiveDeleteWorktreeModal';
import { WorktreeFormFields } from '../WorktreeFormFields';
import { renderEnvCell } from './WorktreeEnvColumn';

interface WorktreesTableProps {
  worktreeById: Map<string, Worktree>;
  repoById: Map<string, Repo>;
  boardById: Map<string, Board>;
  sessionsByWorktree: Map<string, Session[]>; // O(1) worktree filtering
  onArchiveOrDelete?: (
    worktreeId: string,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    }
  ) => void;
  onUnarchive?: (worktreeId: string, options?: { boardId?: string }) => void;
  onCreate?: (
    repoId: string,
    data: {
      name: string;
      ref: string;
      createBranch: boolean;
      sourceBranch: string;
      pullLatest: boolean;
      boardId?: string;
    }
  ) => void;
  onRowClick?: (worktree: Worktree) => void;
  onStartEnvironment?: (worktreeId: string) => void;
  onStopEnvironment?: (worktreeId: string) => void;
}

export const WorktreesTable: React.FC<WorktreesTableProps> = ({
  worktreeById,
  repoById,
  boardById,
  sessionsByWorktree,
  onArchiveOrDelete,
  onUnarchive,
  onCreate,
  onRowClick,
  onStartEnvironment,
  onStopEnvironment,
}) => {
  const repos = mapToArray(repoById);
  const boards = mapToArray(boardById);
  const { token } = theme.useToken();
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [useSameBranchName, setUseSameBranchName] = useState(true);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [isFormValid, setIsFormValid] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [archiveFilter, setArchiveFilter] = useState<'all' | 'active' | 'archived' | 'agents'>(
    'active'
  );
  const [archiveDeleteModalOpen, setArchiveDeleteModalOpen] = useState(false);
  const [selectedWorktree, setSelectedWorktree] = useState<Worktree | null>(null);
  const [hoveredArchiveButton, setHoveredArchiveButton] = useState<string | null>(null);

  // No need for reposById anymore, we already have it as a prop

  // Validate form fields to enable/disable Create button
  const validateForm = useCallback(() => {
    const values = form.getFieldsValue();
    const hasRepo = !!values.repoId;
    const hasSourceBranch = !!values.sourceBranch;
    const hasName = !!values.name && /^[a-z0-9-]+$/.test(values.name);
    const hasBranchName = useSameBranchName || !!values.branchName;

    setIsFormValid(hasRepo && hasSourceBranch && hasName && hasBranchName);
  }, [form, useSameBranchName]);

  // Set default values when modal opens
  useEffect(() => {
    if (createModalOpen && repos.length > 0) {
      // Get last used values from localStorage or use first repo/board
      const lastRepoId = localStorage.getItem('agor:lastUsedRepoId');
      const lastBoardId = localStorage.getItem('agor:lastUsedBoardId');

      const defaultRepoId =
        lastRepoId && repos.find((r: Repo) => r.repo_id === lastRepoId)
          ? lastRepoId
          : repos[0].repo_id;

      const defaultBoardId =
        lastBoardId && boards.find((b: Board) => b.board_id === lastBoardId)
          ? lastBoardId
          : boards.length > 0
            ? boards[0].board_id
            : undefined;

      // Set form initial values
      form.setFieldsValue({
        repoId: defaultRepoId,
        boardId: defaultBoardId,
        sourceBranch:
          repos.find((r: Repo) => r.repo_id === defaultRepoId)?.default_branch || 'main',
      });

      setSelectedRepoId(defaultRepoId);
      validateForm();
    }
  }, [createModalOpen, repos, boards, form, validateForm]);

  // Helper to get repo name from repo_id
  const getRepoName = (repoId: string): string => {
    const repo = repoById.get(repoId as Repo['repo_id']);
    return repo?.name || 'Unknown Repo';
  };

  // Get selected repo's default branch
  const getDefaultBranch = (): string => {
    if (!selectedRepoId) return 'main';
    const repo = repos.find((r: Repo) => r.repo_id === selectedRepoId);
    return repo?.default_branch || 'main';
  };

  // Update source branch when repo changes
  const handleRepoChange = (repoId: string) => {
    setSelectedRepoId(repoId);
    const repo = repos.find((r: Repo) => r.repo_id === repoId);
    const defaultBranch = repo?.default_branch || 'main';
    form.setFieldValue('sourceBranch', defaultBranch);
  };

  const handleArchiveOrDelete = (
    worktreeId: string,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    }
  ) => {
    onArchiveOrDelete?.(worktreeId, options);
  };

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      const branchName = useSameBranchName ? values.name : values.branchName;

      // Save last used repo and board to localStorage for next time
      localStorage.setItem('agor:lastUsedRepoId', values.repoId);
      if (values.boardId) {
        localStorage.setItem('agor:lastUsedBoardId', values.boardId);
      }

      onCreate?.(values.repoId, {
        name: values.name,
        ref: branchName,
        createBranch: true, // Always create new branch based on source branch
        sourceBranch: values.sourceBranch,
        pullLatest: true, // Always fetch latest before creating worktree
        boardId: values.boardId, // Optional: add to board
      });
      setCreateModalOpen(false);
      form.resetFields();
      setUseSameBranchName(true);
      setSelectedRepoId(null);
    } catch (error) {
      console.error('Validation failed:', error);
    }
  };

  const handleCancel = () => {
    setCreateModalOpen(false);
    form.resetFields();
    setUseSameBranchName(true);
    setSelectedRepoId(null);
    setIsFormValid(false);
  };

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record: Worktree) => (
        <Space>
          {isPersistedAgent(record) ? (
            <RobotOutlined style={{ color: token.colorInfo }} />
          ) : (
            <BranchesOutlined />
          )}
          <Typography.Text strong>{name}</Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Env',
      key: 'env',
      width: 120,
      align: 'center' as const,
      render: (_: unknown, record: Worktree) => {
        const repo = repos.find((r: Repo) => r.repo_id === record.repo_id);
        return renderEnvCell(record, repo, token, { onStartEnvironment, onStopEnvironment });
      },
    },
    {
      title: 'Repo',
      dataIndex: 'repo_id',
      key: 'repo_id',
      render: (repoId: string) => (
        <Space>
          <FolderOutlined />
          <Typography.Text>{getRepoName(repoId)}</Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Branch',
      dataIndex: 'ref',
      key: 'ref',
      render: (ref: string) => <Typography.Text code>{ref}</Typography.Text>,
    },
    {
      title: 'Sessions',
      key: 'sessions',
      width: 100,
      render: (_: unknown, record: Worktree) => {
        const sessionCount = (sessionsByWorktree.get(record.worktree_id) || []).length;
        return (
          <Typography.Text type="secondary">
            {sessionCount} {sessionCount === 1 ? 'session' : 'sessions'}
          </Typography.Text>
        );
      },
    },
    {
      title: 'Path',
      key: 'path',
      width: 60,
      align: 'center' as const,
      render: (_: unknown, record: Worktree) => (
        <Typography.Text
          copyable={{
            text: record.path,
            tooltips: [`Copy path: ${record.path}`, 'Copied!'],
          }}
        />
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 130,
      render: (_: unknown, record: Worktree) => (
        <Space size="small">
          <Tooltip title={record.archived ? 'Archived • Click to unarchive' : 'Click to archive'}>
            <Button
              type="text"
              size="small"
              icon={
                hoveredArchiveButton === record.worktree_id ? (
                  // Hovered: show opposite icon (preview the action)
                  record.archived ? (
                    <DropboxOutlined style={{ color: token.colorSuccess }} />
                  ) : (
                    <CodeSandboxOutlined style={{ color: token.colorWarning }} />
                  )
                ) : // Not hovered: show current state
                record.archived ? (
                  <CodeSandboxOutlined style={{ color: token.colorWarning }} />
                ) : (
                  <DropboxOutlined style={{ color: token.colorTextSecondary }} />
                )
              }
              onMouseEnter={() => setHoveredArchiveButton(record.worktree_id)}
              onMouseLeave={() => setHoveredArchiveButton(null)}
              onClick={(e) => {
                e.stopPropagation();
                if (record.archived) {
                  onUnarchive?.(record.worktree_id);
                } else {
                  setSelectedWorktree(record);
                  setArchiveDeleteModalOpen(true);
                }
              }}
            />
          </Tooltip>
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            onClick={(e) => {
              e.stopPropagation();
              onRowClick?.(record);
            }}
          />
          <Button
            type="text"
            size="small"
            icon={<DeleteOutlined />}
            danger
            onClick={(e) => {
              e.stopPropagation();
              setSelectedWorktree(record);
              setArchiveDeleteModalOpen(true);
            }}
          />
        </Space>
      ),
    },
  ];

  const filteredWorktrees = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    const sorted = Array.from(worktreeById.values()).sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    // Filter by archive status / type
    let filtered = sorted;
    if (archiveFilter === 'active') {
      filtered = sorted.filter((w) => !w.archived);
    } else if (archiveFilter === 'archived') {
      filtered = sorted.filter((w) => w.archived);
    } else if (archiveFilter === 'agents') {
      filtered = sorted.filter((w) => !w.archived && isPersistedAgent(w));
    }

    // Filter by search term
    if (!term) {
      return filtered;
    }

    return filtered.filter((worktree) => {
      const repo = repoById.get(worktree.repo_id);
      const haystacks = [
        worktree.name,
        worktree.ref,
        worktree.path,
        String(worktree.worktree_unique_id),
        repo?.name,
        repo?.slug,
      ];

      return haystacks.some((value) => {
        if (value === undefined || value === null) {
          return false;
        }
        return value.toString().toLowerCase().includes(term);
      });
    });
  }, [archiveFilter, repoById, searchTerm, worktreeById]);

  return (
    <div>
      <Space
        direction="vertical"
        size={token.sizeUnit * 2}
        style={{ marginBottom: token.sizeUnit * 2, width: '100%' }}
      >
        <Typography.Text type="secondary">
          Manage git worktrees for isolated development contexts across sessions.
        </Typography.Text>
        <Space style={{ width: '100%', display: 'flex', justifyContent: 'space-between' }}>
          <Space>
            <Input
              allowClear
              placeholder="Search by name, repo, slug, path, or ID"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              style={{ maxWidth: token.sizeUnit * 40 }}
            />
            <Select
              value={archiveFilter}
              onChange={(value) => setArchiveFilter(value)}
              style={{ width: 120 }}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'agents', label: 'Agents' },
                { value: 'all', label: 'All' },
                { value: 'archived', label: 'Archived' },
              ]}
            />
          </Space>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setCreateModalOpen(true)}
            disabled={repos.length === 0}
          >
            Create Worktree
          </Button>
        </Space>
      </Space>

      {repos.length === 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 400,
          }}
        >
          <Empty description="No repositories configured">
            <Typography.Text type="secondary">
              Create a repository first in the Repositories tab to enable worktrees.
            </Typography.Text>
          </Empty>
        </div>
      )}

      {repos.length > 0 && worktreeById.size === 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 400,
          }}
        >
          <Empty description="No worktrees yet">
            <Typography.Text type="secondary">
              Worktrees will appear here once created from sessions or the CLI.
            </Typography.Text>
          </Empty>
        </div>
      )}

      {worktreeById.size > 0 && (
        <Table
          dataSource={filteredWorktrees}
          columns={columns}
          rowKey="worktree_id"
          pagination={{ pageSize: 10 }}
          size="small"
          onRow={(record) => ({
            onClick: () => onRowClick?.(record),
            style: { cursor: onRowClick ? 'pointer' : 'default' },
          })}
        />
      )}

      <Modal
        title="Create Worktree"
        open={createModalOpen}
        onOk={handleCreate}
        onCancel={handleCancel}
        okText="Create"
        okButtonProps={{
          disabled: !isFormValid,
        }}
      >
        <Form form={form} layout="vertical" onFieldsChange={validateForm}>
          <WorktreeFormFields
            repoById={repoById}
            boardById={boardById}
            selectedRepoId={selectedRepoId}
            onRepoChange={handleRepoChange}
            defaultBranch={getDefaultBranch()}
            showBoardSelector={true}
            onFormChange={validateForm}
            useSameBranchName={useSameBranchName}
            onUseSameBranchNameChange={setUseSameBranchName}
          />
        </Form>
      </Modal>

      {selectedWorktree && (
        <ArchiveDeleteWorktreeModal
          open={archiveDeleteModalOpen}
          worktree={selectedWorktree}
          sessionCount={(sessionsByWorktree.get(selectedWorktree.worktree_id) || []).length}
          environmentRunning={selectedWorktree.environment_instance?.status === 'running'}
          onConfirm={(options) => {
            handleArchiveOrDelete(selectedWorktree.worktree_id, options);
            setArchiveDeleteModalOpen(false);
            setSelectedWorktree(null);
          }}
          onCancel={() => {
            setArchiveDeleteModalOpen(false);
            setSelectedWorktree(null);
          }}
        />
      )}
    </div>
  );
};
