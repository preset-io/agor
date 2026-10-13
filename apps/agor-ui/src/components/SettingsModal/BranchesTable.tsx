import type {
  AgorClient,
  Board,
  Branch,
  BranchArchiveOrDeleteOptions,
  Repo,
  User,
} from '@agor-live/client';
import { isTeammate, serverSearchText } from '@agor-live/client';
import {
  AimOutlined,
  BranchesOutlined,
  DeleteOutlined,
  EditOutlined,
  FolderOutlined,
  PlusOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { Button, Empty, Form, Input, Select, Space, Tooltip, Typography, theme } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BranchStorageConfig } from '@/utils/branchStorage';
import { normalizeBranchStorageMode } from '@/utils/branchStorage';
import { mapToArray } from '@/utils/mapHelpers';
import { filterBySettingsSearch } from '@/utils/settingsSearch';
import { useAppNavigation } from '../../hooks/useAppNavigation';
import { useAgorStore } from '../../store/agorStore';
import { selectTeammatesLoaded } from '../../store/userScope';
import { ArchiveToggleButton } from '../ArchiveButton';
import { ArchiveDeleteBranchModal } from '../ArchiveDeleteBranchModal';
import { BranchFormFields } from '../BranchFormFields';
import { useDebouncedSearchQuery } from '../GlobalSearch/useGlobalSearch';
import { HighlightMatch } from '../HighlightMatch';
import { renderEnvCell } from './BranchEnvColumn';
import { ResponsiveSettingsHeader } from './ResponsiveSettingsHeader';
import { ResponsiveTable } from './ResponsiveTable';
import { SettingsActionGroup } from './SettingsActionGroup';
import { DrillInFrame, useDrillFormDraft, useSettingsDrill } from './SettingsDrill';
import { useBranchPage, useSessionCounts } from './useBranchPage';

interface BranchesTableProps {
  currentUser?: User | null;
  client: AgorClient | null;
  /** The store's branches: navigation and the Teammates filter (the user scope holds every teammate). */
  branchById: Map<string, Branch>;
  repoById: Map<string, Repo>;
  boardById: Map<string, Board>;
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
      storage_mode?: 'worktree' | 'clone';
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
  onArchiveOrDelete,
  onUnarchive,
  onCreate,
  onRowClick,
  onStartEnvironment,
  onStopEnvironment,
  onClose,
  branchStorageConfig,
  currentUser,
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
  // "Create Branch" opens in place as the section's drill-in (like branch edit
  // and teammate create) rather than stacking a Modal on top of Settings.
  const { drill, openDrill, closeDrill } = useSettingsDrill();
  const createModalOpen = drill?.mode === 'create';
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
  const [initialArchiveDeleteAction, setInitialArchiveDeleteAction] = useState<
    'archive' | 'delete'
  >('archive');
  const [pageSize, setPageSize] = useState(10);
  const { debouncedQuery } = useDebouncedSearchQuery(searchTerm);
  const search = debouncedQuery.trim();
  // A new filter or search starts again on its first page, in the same
  // render: the page belongs to the filter and search it was chosen under.
  // Repo filter (server-side `repo_id`); undefined lists every repo.
  const [repoFilter, setRepoFilter] = useState<string | undefined>();
  const pageKey = `${archiveFilter}\u0000${search}\u0000${repoFilter ?? ''}`;
  const [paged, setPaged] = useState({ key: pageKey, page: 1 });
  // Forget the old page when the key changes, so returning to it starts on 1.
  if (paged.key !== pageKey) setPaged({ key: pageKey, page: 1 });
  const page = paged.key === pageKey ? paged.page : 1;
  const setPage = (next: number) => setPaged({ key: pageKey, page: next });

  // Every filter but Teammates pages on the daemon (`search` included). The
  // daemon can't combine `teammate` with `search`; the user scope already
  // holds every visible teammate, so that filter pages over the store.
  const teammatesFilter = archiveFilter === 'teammates';
  const branchPage = useBranchPage(
    client,
    teammatesFilter
      ? null
      : {
          ...(archiveFilter === 'all' ? {} : { archived: archiveFilter === 'archived' }),
          ...(search ? { search: serverSearchText(search) } : {}),
          ...(repoFilter ? { repo_id: repoFilter } : {}),
        },
    page,
    pageSize
  );
  const teammatesLoaded = useAgorStore(selectTeammatesLoaded);
  const teammates = useMemo(
    () =>
      teammatesFilter
        ? filterBySettingsSearch(
            Array.from(branchById.values())
              .filter(
                (b) => !b.archived && isTeammate(b) && (!repoFilter || b.repo_id === repoFilter)
              )
              .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
            search,
            [
              (b) => [b.name, b.ref, b.path, b.branch_id, String(b.branch_unique_id)],
              (b) => [repoById.get(b.repo_id)?.name, repoById.get(b.repo_id)?.slug],
            ]
          )
        : [],
    [teammatesFilter, branchById, repoById, search, repoFilter]
  );
  const rows = teammatesFilter
    ? teammates.slice((page - 1) * pageSize, page * pageSize)
    : branchPage.rows;
  const total = teammatesFilter ? teammates.length : branchPage.total;
  const loading = teammatesFilter ? !teammatesLoaded && teammates.length === 0 : branchPage.loading;
  const sessionCounts = useSessionCounts(client, 'branch_id');

  // Validate form fields to enable/disable Create button
  const validateForm = useCallback(() => {
    const values = form.getFieldsValue();
    const hasRepo = !!values.repoId;
    const hasSourceBranch = !!values.sourceBranch;
    const hasName = !!values.name && /^[a-z0-9-]+$/.test(values.name);
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
  const isCreateDirty = useDrillFormDraft(form, createModalOpen ? drill : null);

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

    // Acceptance is not removal: read the page again while the authoritative
    // patched/removed events are on their way.
    branchPage.refresh();
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
      closeDrill();
      form.resetFields();
      setUseSameBranchName(true);
      setSelectedRepoId(null);
    } catch (error) {
      console.error('Validation failed:', error);
    }
  };

  const handleCancel = () => {
    closeDrill();
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
              <Typography.Link
                ellipsis
                title={name}
                onClick={() => onRowClick?.(record)}
                style={{ display: 'block', maxWidth: '100%' }}
              >
                <HighlightMatch text={name} query={searchTerm} />
              </Typography.Link>
              {record.deletion_status && (
                <Typography.Text
                  type={record.deletion_status === 'deletion_failed' ? 'danger' : 'secondary'}
                  title={record.deletion_error}
                >
                  {record.deletion_status === 'deletion_failed'
                    ? 'Deletion failed. Open deletion to retry.'
                    : 'Deleting…'}
                </Typography.Text>
              )}
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
        if (record.deletion_status)
          return <Typography.Text type="secondary">Unavailable</Typography.Text>;
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
        const sessionCount = sessionCounts.get(record.branch_id);
        if (sessionCount === undefined) return null;
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
                ).catch(() => {
                  // Error surfaced by parent handler (toast); keep local state unchanged
                });
                // Only authoritative branch events update this cache. An ack
                // means accepted, not ready; a lost ack may arrive after unmount.
                return;
              }
              setSelectedBranch(record);
              setInitialArchiveDeleteAction('archive');
              setArchiveDeleteModalOpen(true);
            }}
          />
          <Tooltip title="Edit branch">
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                onRowClick?.(record);
              }}
            />
          </Tooltip>
          <Tooltip title="Delete branch">
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
          </Tooltip>
        </SettingsActionGroup>
      ),
    },
  ];

  // "Create Branch" renders in place (drill-in) instead of a stacked Modal,
  // matching branch edit (embedded BranchModal) and teammate create.
  if (createModalOpen) {
    return (
      <DrillInFrame
        title="Create Branch"
        saveLabel="Create"
        saveDisabled={!isFormValid}
        dirty={isCreateDirty}
        onSave={handleCreate}
        onBack={handleCancel}
      >
        <div style={{ maxWidth: 640 }}>
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
        </div>
      </DrillInFrame>
    );
  }

  return (
    <div>
      <ResponsiveSettingsHeader
        title="Branches"
        description="Manage git branches for isolated development contexts across sessions."
        search={
          <Input
            allowClear
            placeholder="Search by name, ref, notes, or URL"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />
        }
        filters={
          <>
            <Select
              aria-label="Status"
              value={archiveFilter}
              onChange={(value) => setArchiveFilter(value)}
              style={{ width: 120 }}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'teammates', label: 'Teammates' },
                { value: 'all', label: 'All' },
                { value: 'archived', label: 'Archived' },
              ]}
            />
            <Select
              aria-label="Repository"
              allowClear
              placeholder="All repos"
              value={repoFilter}
              onChange={setRepoFilter}
              style={{ width: 200 }}
              options={repos
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((r) => ({ value: r.repo_id, label: r.name }))}
            />
          </>
        }
        primaryActions={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => openDrill({ mode: 'create' })}
            disabled={repos.length === 0}
          >
            Create Branch
          </Button>
        }
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
          <Empty description="No repositories configured">
            <Typography.Text type="secondary">
              Create a repository first in the Repositories tab to enable branches.
            </Typography.Text>
          </Empty>
        </div>
      )}

      {repos.length > 0 && (
        <ResponsiveTable
          dataSource={rows}
          columns={columns}
          rowKey="branch_id"
          loading={loading}
          pagination={{
            current: page,
            pageSize,
            total,
            onChange: (nextPage, nextPageSize) => {
              setPage(nextPageSize === pageSize ? nextPage : 1);
              setPageSize(nextPageSize);
            },
          }}
          size="small"
        />
      )}

      {selectedBranch && (
        <ArchiveDeleteBranchModal
          client={client}
          currentUser={currentUser}
          open={archiveDeleteModalOpen}
          branch={selectedBranch}
          sessionCount={sessionCounts.get(selectedBranch.branch_id)}
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
