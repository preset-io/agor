import type { AgorClient, Board, Repo, Session, Worktree } from '@agor-live/client';
import { isAssistant } from '@agor-live/client';
import {
  BranchesOutlined,
  DeleteOutlined,
  EditOutlined,
  FolderOutlined,
  PlusOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { Button, Empty, Form, Input, Modal, Select, Space, Table, Typography, theme } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mapToArray } from '@/utils/mapHelpers';
import { ArchiveDeleteWorktreeModal } from '../ArchiveDeleteWorktreeModal';
import { ArchiveToggleButton } from '../ArchiveToggleButton';
import { WorktreeFormFields } from '../WorktreeFormFields';
import { renderEnvCell } from './WorktreeEnvColumn';

interface WorktreesTableProps {
  client: AgorClient | null;
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
  ) => void | Promise<void>;
  onUnarchive?: (worktreeId: string, options?: { boardId?: string }) => void | Promise<void>;
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
  client,
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
  const [archiveFilter, setArchiveFilter] = useState<'all' | 'active' | 'archived' | 'assistants'>(
    'active'
  );
  const [archiveDeleteModalOpen, setArchiveDeleteModalOpen] = useState(false);
  const [selectedWorktree, setSelectedWorktree] = useState<Worktree | null>(null);
  const [archivedWorktrees, setArchivedWorktrees] = useState<Worktree[]>([]);
  const [archivedLoaded, setArchivedLoaded] = useState(false);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const archivedFetchingRef = useRef(false);

  // No need for reposById anymore, we already have it as a prop

  useEffect(() => {
    if (archiveFilter !== 'archived' && archiveFilter !== 'all') {
      return;
    }
    if (archivedLoaded || archivedFetchingRef.current || !client) {
      return;
    }

    let cancelled = false;
    archivedFetchingRef.current = true;
    setArchivedLoading(true);

    client
      .service('worktrees')
      .findAll({ query: { archived: true, $limit: 1000, $sort: { created_at: -1 } } })
      .then((result) => {
        if (cancelled) return;
        setArchivedWorktrees(result as Worktree[]);
        setArchivedLoaded(true);
      })
      .catch(() => {
        // Keep table functional with active-only data if archived fetch fails
      })
      .finally(() => {
        archivedFetchingRef.current = false;
        if (!cancelled) {
          setArchivedLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [archiveFilter, archivedLoaded, client]);

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

  const handleArchiveOrDelete = async (
    worktreeId: string,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    }
  ) => {
    try {
      await onArchiveOrDelete?.(worktreeId, options);
    } catch {
      return;
    }

    if (options.metadataAction === 'archive') {
      const source =
        worktreeById.get(worktreeId) ||
        archivedWorktrees.find((worktree) => worktree.worktree_id === worktreeId);
      if (source) {
        const archivedCopy: Worktree = {
          ...source,
          archived: true,
          archived_at: new Date().toISOString(),
        };
        setArchivedWorktrees((prev) => {
          const index = prev.findIndex((worktree) => worktree.worktree_id === worktreeId);
          if (index === -1) return [archivedCopy, ...prev];
          const next = [...prev];
          next[index] = archivedCopy;
          return next;
        });
      }
      return;
    }

    // Hard-delete should disappear from both active + archived local sets
    setArchivedWorktrees((prev) => prev.filter((worktree) => worktree.worktree_id !== worktreeId));
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
          {isAssistant(record) ? (
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
          <ArchiveToggleButton
            archived={record.archived}
            onToggle={(nextArchived) => {
              if (!nextArchived) {
                void Promise.resolve(
                  onUnarchive?.(
                    record.worktree_id,
                    record.board_id ? { boardId: record.board_id } : undefined
                  )
                )
                  .then(() => {
                    setArchivedWorktrees((prev) =>
                      prev.map((worktree) =>
                        worktree.worktree_id === record.worktree_id
                          ? {
                              ...worktree,
                              archived: false,
                              archived_at: undefined,
                              archived_by: undefined,
                            }
                          : worktree
                      )
                    );
                  })
                  .catch(() => {
                    // Error surfaced by parent handler (toast); keep local state unchanged
                  });
                return;
              }
              setSelectedWorktree(record);
              setArchiveDeleteModalOpen(true);
            }}
          />
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
    const activeWorktrees = Array.from(worktreeById.values());
    const mergedById = new Map<string, Worktree>();
    for (const worktree of activeWorktrees) {
      mergedById.set(worktree.worktree_id, worktree);
    }
    for (const worktree of archivedWorktrees) {
      if (!mergedById.has(worktree.worktree_id)) {
        mergedById.set(worktree.worktree_id, worktree);
      }
    }

    const sorted = Array.from(mergedById.values()).sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    // Filter by archive status / type
    let filtered = sorted;
    if (archiveFilter === 'active') {
      filtered = sorted.filter((w) => !w.archived);
    } else if (archiveFilter === 'archived') {
      filtered = sorted.filter((w) => w.archived);
    } else if (archiveFilter === 'assistants') {
      filtered = sorted.filter((w) => !w.archived && isAssistant(w));
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
  }, [archiveFilter, archivedWorktrees, repoById, searchTerm, worktreeById]);
  const hasAnyWorktrees = worktreeById.size > 0 || archivedWorktrees.length > 0;

  return (
    <div>
      <Space
        orientation="vertical"
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
              loading={archivedLoading && (archiveFilter === 'archived' || archiveFilter === 'all')}
              style={{ width: 120 }}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'assistants', label: 'Assistants' },
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

      {repos.length > 0 && !hasAnyWorktrees && (
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

      {hasAnyWorktrees && (
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
