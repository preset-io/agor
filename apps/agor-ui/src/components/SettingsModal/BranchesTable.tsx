import type {
  AgorClient,
  Board,
  Branch,
  BranchArchiveOrDeleteOptions,
  BranchMetadataAction,
  BranchStorageMode,
  Repo,
  Session,
} from '@agor-live/client';
import { isTeammate, isValidManagedBranchName } from '@agor-live/client';
import {
  AimOutlined,
  BranchesOutlined,
  DeleteOutlined,
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
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BranchStorageConfig } from '@/utils/branchStorage';
import { normalizeBranchStorageMode } from '@/utils/branchStorage';
import { mapToArray } from '@/utils/mapHelpers';
import { useAppNavigation } from '../../hooks/useAppNavigation';
import { ArchiveToggleButton } from '../ArchiveButton';
import { ArchiveDeleteBranchModal } from '../ArchiveDeleteBranchModal';
import { BranchFormFields } from '../BranchFormFields';
import { HighlightMatch } from '../HighlightMatch';
import { renderEnvCell } from './BranchEnvColumn';
import { SettingsActionGroup } from './SettingsActionGroup';

interface BranchesTableProps {
  client: AgorClient | null;
  branchById: Map<string, Branch>;
  repoById: Map<string, Repo>;
  boardById: Map<string, Board>;
  sessionsByBranch: Map<string, Session[]>; // O(1) branch filtering
  onArchiveOrDelete?: (
    branchId: string,
    options: BranchArchiveOrDeleteOptions
  ) => void | Promise<void>;
  onUnarchive?: (branchId: string, options?: { boardId?: string }) => void | Promise<void>;
  onCreate?: (
    repoId: string,
    data: {
      name: string;
      ref: string;
      createBranch: boolean;
      sourceBranch: string;
      pullLatest: boolean;
      boardId?: string;
      storage_mode?: BranchStorageMode;
      clone_depth?: number;
    }
  ) => void;
  onRowClick?: (branch: Branch) => void;
  onStartEnvironment?: (branchId: string) => void;
  onStopEnvironment?: (branchId: string) => void;
  /** Close the parent Settings modal. Used by the recenter action so the
   *  canvas isn't obscured by the modal after pan/zoom. */
  onClose?: () => void;
  branchStorageConfig?: BranchStorageConfig;
}

export const BranchesTable: React.FC<BranchesTableProps> = ({
  client,
  branchById,
  repoById,
  boardById,
  sessionsByBranch,
  onArchiveOrDelete,
  onUnarchive,
  onCreate,
  onRowClick,
  onStartEnvironment,
  onStopEnvironment,
  onClose,
  branchStorageConfig,
}) => {
  const repos = mapToArray(repoById);
  const boards = mapToArray(boardById);
  const { token } = theme.useToken();
  // Reuses the `branchById` prop so we don't read the same data via
  // both props and context. Only goToBranch is used from this table.
  const navigation = useAppNavigation({ boardById, branchById });

  const handleRecenter = useCallback(
    (branch: Branch) => {
      // Close the modal first so the canvas isn't obscured by it after
      // the pan/zoom. goToBranch pushes the flat `/w/<short>/` URL;
      // useUrlState's URL→state effect resolves the branch, switches
      // boards if needed, and fires the recenter via recenterMap.
      onClose?.();
      navigation.goToBranch(branch.branch_id);
    },
    [onClose, navigation]
  );
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [useSameBranchName, setUseSameBranchName] = useState(true);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [isFormValid, setIsFormValid] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [archiveFilter, setArchiveFilter] = useState<'all' | 'active' | 'archived' | 'teammates'>(
    'active'
  );
  const [archiveDeleteModalOpen, setArchiveDeleteModalOpen] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState<Branch | null>(null);
  const [initialArchiveDeleteAction, setInitialArchiveDeleteAction] =
    useState<BranchMetadataAction>('archive');
  const [archivedBranches, setArchivedBranches] = useState<Branch[]>([]);
  const [archivedLoaded, setArchivedLoaded] = useState(false);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const archivedFetchingRef = useRef(false);
  const archivedRealtimeRef = useRef<{
    removed: Set<string>;
    patched: Map<string, Branch>;
  }>({ removed: new Set(), patched: new Map() });

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
      .service('branches')
      .findAll({ query: { archived: true, $limit: 1000, $sort: { created_at: -1 } } })
      .then((result) => {
        if (cancelled) return;
        // Reconcile realtime writes that landed after the request began. A
        // wholesale assignment here would resurrect a hard-deleted row from
        // a stale response or lose a branch archived by another replica.
        const byId = new Map<string, Branch>(
          (result as Branch[]).map((branch) => [branch.branch_id, branch] as const)
        );
        for (const branchId of archivedRealtimeRef.current.removed) byId.delete(branchId);
        for (const [branchId, branch] of archivedRealtimeRef.current.patched) {
          if (branch.archived) byId.set(branchId, branch);
          else byId.delete(branchId);
        }
        setArchivedBranches([...byId.values()]);
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

  // Archived branches are intentionally absent from the main branch store.
  // Keep the locally fetched archived rows current while the asynchronous
  // executor publishes deleting -> deleted/delete_failed transitions, and
  // evict hard-deleted metadata after the authoritative removed event.
  useEffect(() => {
    // A client change can represent a reconnect to a different authenticated
    // tenant. Never carry archived rows or event tombstones across that boundary.
    archivedRealtimeRef.current = { removed: new Set(), patched: new Map() };
    archivedFetchingRef.current = false;
    setArchivedBranches([]);
    setArchivedLoaded(false);
    setArchivedLoading(false);
    if (!client) return;
    const branchesService = client.service('branches');
    const handlePatched = (branch: Branch) => {
      if (branch.archived) {
        archivedRealtimeRef.current.removed.delete(branch.branch_id);
        archivedRealtimeRef.current.patched.set(branch.branch_id, branch);
      } else {
        archivedRealtimeRef.current.patched.delete(branch.branch_id);
        archivedRealtimeRef.current.removed.add(branch.branch_id);
      }
      setArchivedBranches((previous) => {
        const index = previous.findIndex((candidate) => candidate.branch_id === branch.branch_id);
        if (!branch.archived) {
          return index === -1
            ? previous
            : previous.filter((_, candidateIndex) => candidateIndex !== index);
        }
        if (index === -1) return [branch, ...previous];
        const next = [...previous];
        next[index] = branch;
        return next;
      });
    };
    const handleRemoved = (branch: Branch) => {
      archivedRealtimeRef.current.patched.delete(branch.branch_id);
      archivedRealtimeRef.current.removed.add(branch.branch_id);
      setArchivedBranches((previous) =>
        previous.filter((candidate) => candidate.branch_id !== branch.branch_id)
      );
    };

    branchesService.on('patched', handlePatched);
    branchesService.on('removed', handleRemoved);
    return () => {
      branchesService.removeListener('patched', handlePatched);
      branchesService.removeListener('removed', handleRemoved);
    };
  }, [client]);

  // Validate form fields to enable/disable Create button
  const validateForm = useCallback(() => {
    const values = form.getFieldsValue();
    const hasRepo = !!values.repoId;
    const hasSourceBranch = !!values.sourceBranch;
    const hasName = isValidManagedBranchName(values.name);
    const hasBranchName = useSameBranchName || !!values.branchName;
    const hasBoard = !!values.boardId;

    setIsFormValid(hasRepo && hasSourceBranch && hasName && hasBranchName && hasBoard);
  }, [form, useSameBranchName]);

  // Initialize form once per modal-open session. Without the useRef guard
  // the effect re-fires whenever `repoById` / `boardById` get new Map
  // references from any `repos.patched` / `boards.patched` WebSocket
  // event, and `setFieldsValue({ sourceBranch })` silently overwrites
  // whatever the user typed back to the repo's default branch. Same
  // anti-pattern as the NewBranchModal / BranchTab fix in this PR;
  // missed in the first pass because this surface lives in Settings.
  const createInitialized = useRef(false);
  useEffect(() => {
    if (!createModalOpen) {
      createInitialized.current = false;
      return;
    }
    if (createInitialized.current || repos.length === 0) return;
    createInitialized.current = true;

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
      sourceBranch: repos.find((r: Repo) => r.repo_id === defaultRepoId)?.default_branch || 'main',
    });

    setSelectedRepoId(defaultRepoId);
    validateForm();
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

  const handleArchiveOrDelete = async (branchId: string, options: BranchArchiveOrDeleteOptions) => {
    try {
      await onArchiveOrDelete?.(branchId, options);
    } catch {
      return;
    }

    if (options.metadataAction === 'archive') {
      const source =
        branchById.get(branchId) ||
        archivedBranches.find((branch) => branch.branch_id === branchId);
      if (source) {
        const archivedCopy: Branch = {
          ...source,
          archived: true,
          archived_at: new Date().toISOString(),
          filesystem_status:
            options.filesystemAction === 'deleted' ? 'deleting' : options.filesystemAction,
        };
        setArchivedBranches((prev) => {
          const index = prev.findIndex((branch) => branch.branch_id === branchId);
          if (index === -1) return [archivedCopy, ...prev];
          const next = [...prev];
          next[index] = archivedCopy;
          return next;
        });
      }
      return;
    }

    // Hard-delete should disappear from both active + archived local sets
    setArchivedBranches((prev) => prev.filter((branch) => branch.branch_id !== branchId));
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

      const storageMode = normalizeBranchStorageMode(values.storage_mode, branchStorageConfig);
      const cloneDepth =
        storageMode === 'clone' && typeof values.clone_depth === 'number' && values.clone_depth > 0
          ? values.clone_depth
          : undefined;
      onCreate?.(values.repoId, {
        name: values.name,
        ref: branchName,
        createBranch: true, // Always create new branch based on source branch
        sourceBranch: values.sourceBranch,
        pullLatest: true, // Always fetch latest before creating branch
        boardId: values.boardId,
        storage_mode: storageMode,
        ...(cloneDepth !== undefined ? { clone_depth: cloneDepth } : {}),
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
      title: 'Branch',
      dataIndex: 'name',
      key: 'branch',
      render: (name: string, record: Branch) => {
        const nameMatchesRef = name === record.ref;
        return (
          <Space style={{ minWidth: 0, width: '100%' }}>
            {isTeammate(record) ? (
              <RobotOutlined style={{ color: token.colorInfo }} />
            ) : (
              <BranchesOutlined />
            )}
            <Space orientation="vertical" size={0} style={{ minWidth: 0, flex: 1 }}>
              <Typography.Text
                strong
                ellipsis={{ tooltip: name }}
                style={{ display: 'block', maxWidth: '100%' }}
              >
                <HighlightMatch text={name} query={searchTerm} />
              </Typography.Text>
              {!nameMatchesRef && (
                <Typography.Text
                  code
                  type="secondary"
                  ellipsis={{ tooltip: record.ref }}
                  style={{ display: 'block', maxWidth: '100%' }}
                >
                  <HighlightMatch text={record.ref} query={searchTerm} />
                </Typography.Text>
              )}
            </Space>
          </Space>
        );
      },
    },
    {
      title: 'Env',
      key: 'env',
      width: 120,
      align: 'center' as const,
      render: (_: unknown, record: Branch) => {
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
          <Typography.Text>
            <HighlightMatch text={getRepoName(repoId)} query={searchTerm} />
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Sessions',
      key: 'sessions',
      width: 100,
      render: (_: unknown, record: Branch) => {
        const sessionCount = (sessionsByBranch.get(record.branch_id) || []).length;
        return (
          <Typography.Text type="secondary">
            {sessionCount} {sessionCount === 1 ? 'session' : 'sessions'}
          </Typography.Text>
        );
      },
    },
    {
      title: 'Filesystem',
      key: 'filesystem_status',
      width: 110,
      render: (_: unknown, record: Branch) => {
        const status = record.filesystem_status ?? 'ready';
        const label = status.replaceAll('_', ' ');
        const color =
          status === 'delete_failed' || status === 'failed'
            ? 'error'
            : status === 'deleting' || status === 'creating'
              ? 'processing'
              : status === 'deleted'
                ? 'success'
                : 'default';
        return (
          <Tooltip title={record.error_message}>
            <Tag color={color}>{label}</Tag>
          </Tooltip>
        );
      },
    },
    {
      title: 'Path',
      key: 'path',
      width: 60,
      align: 'center' as const,
      render: (_: unknown, record: Branch) => (
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
      width: 144,
      render: (_: unknown, record: Branch) => (
        <SettingsActionGroup>
          {!record.archived && record.board_id && (
            <Tooltip title="Center map on branch">
              <Button
                type="text"
                size="small"
                icon={<AimOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  handleRecenter(record);
                }}
              />
            </Tooltip>
          )}
          <ArchiveToggleButton
            archived={record.archived}
            onToggle={(nextArchived) => {
              if (!nextArchived) {
                void Promise.resolve(
                  onUnarchive?.(
                    record.branch_id,
                    record.board_id ? { boardId: record.board_id } : undefined
                  )
                )
                  .then(() => {
                    setArchivedBranches((prev) =>
                      prev.map((branch) =>
                        branch.branch_id === record.branch_id
                          ? {
                              ...branch,
                              archived: false,
                              archived_at: undefined,
                              archived_by: undefined,
                            }
                          : branch
                      )
                    );
                  })
                  .catch(() => {
                    // Error surfaced by parent handler (toast); keep local state unchanged
                  });
                return;
              }
              setSelectedBranch(record);
              setInitialArchiveDeleteAction('archive');
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
              setSelectedBranch(record);
              setInitialArchiveDeleteAction('delete');
              setArchiveDeleteModalOpen(true);
            }}
          />
        </SettingsActionGroup>
      ),
    },
  ];

  const filteredBranches = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    const activeBranches = Array.from(branchById.values());
    const mergedById = new Map<string, Branch>();
    for (const branch of activeBranches) {
      mergedById.set(branch.branch_id, branch);
    }
    for (const branch of archivedBranches) {
      if (!mergedById.has(branch.branch_id)) {
        mergedById.set(branch.branch_id, branch);
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
    } else if (archiveFilter === 'teammates') {
      filtered = sorted.filter((w) => !w.archived && isTeammate(w));
    }

    // Filter by search term
    if (!term) {
      return filtered;
    }

    return filtered.filter((branch) => {
      const repo = repoById.get(branch.repo_id);
      const haystacks = [
        branch.name,
        branch.ref,
        branch.path,
        String(branch.branch_unique_id),
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
  }, [archiveFilter, archivedBranches, repoById, searchTerm, branchById]);
  const hasAnyBranches = branchById.size > 0 || archivedBranches.length > 0;

  return (
    <div>
      <Space
        orientation="vertical"
        size={token.sizeUnit * 2}
        style={{ marginBottom: token.sizeUnit * 2, width: '100%' }}
      >
        <Typography.Text type="secondary">
          Manage git branches for isolated development contexts across sessions.
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
                { value: 'teammates', label: 'Teammates' },
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
            Create Branch
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
              Create a repository first in the Repositories tab to enable branches.
            </Typography.Text>
          </Empty>
        </div>
      )}

      {repos.length > 0 && !hasAnyBranches && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 400,
          }}
        >
          <Empty description="No branches yet">
            <Typography.Text type="secondary">
              Branches will appear here once created from sessions or the CLI.
            </Typography.Text>
          </Empty>
        </div>
      )}

      {hasAnyBranches && (
        <Table
          dataSource={filteredBranches}
          columns={columns}
          rowKey="branch_id"
          pagination={{ defaultPageSize: 10 }}
          size="small"
          onRow={(record) => ({
            onClick: () => onRowClick?.(record),
            style: { cursor: onRowClick ? 'pointer' : 'default' },
          })}
        />
      )}

      <Modal
        title="Create Branch"
        open={createModalOpen}
        onOk={handleCreate}
        onCancel={handleCancel}
        okText="Create"
        okButtonProps={{
          disabled: !isFormValid,
        }}
      >
        <Form form={form} layout="vertical" onFieldsChange={validateForm}>
          <BranchFormFields
            repoById={repoById}
            boardById={boardById}
            selectedRepoId={selectedRepoId}
            onRepoChange={handleRepoChange}
            defaultBranch={getDefaultBranch()}
            showBoardSelector={true}
            requireBoard
            onFormChange={validateForm}
            useSameBranchName={useSameBranchName}
            onUseSameBranchNameChange={setUseSameBranchName}
            branchStorageConfig={branchStorageConfig}
          />
        </Form>
      </Modal>

      {selectedBranch && (
        <ArchiveDeleteBranchModal
          open={archiveDeleteModalOpen}
          branch={selectedBranch}
          sessionCount={(sessionsByBranch.get(selectedBranch.branch_id) || []).length}
          environmentRunning={selectedBranch.environment_instance?.status === 'running'}
          initialMetadataAction={initialArchiveDeleteAction}
          onConfirm={(options) => {
            handleArchiveOrDelete(selectedBranch.branch_id, options);
            setArchiveDeleteModalOpen(false);
            setSelectedBranch(null);
            setInitialArchiveDeleteAction('archive');
          }}
          onCancel={() => {
            setArchiveDeleteModalOpen(false);
            setSelectedBranch(null);
            setInitialArchiveDeleteAction('archive');
          }}
        />
      )}
    </div>
  );
};
