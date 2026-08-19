import { GOLD_SHIMMER_BOARD_BACKGROUND } from '@agor/core/design/board-backgrounds';
import type {
  AgorClient,
  Board,
  BoardGroupGrantWithGroup,
  Branch,
  BranchFsAccessLevel,
  BranchPermissionLevel,
  Group,
  Session,
  User,
  UUID,
} from '@agor-live/client';
import {
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  PlusOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import {
  App,
  Button,
  Empty,
  Form,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tooltip,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { mapToSortedArray } from '@/utils/mapHelpers';
import { useThemedMessage } from '@/utils/message';
import { filterBySettingsSearch } from '@/utils/settingsSearch';
import { ArchiveToggleButton } from '../ArchiveButton';
import { BoardTile, getBoardEmoji } from '../BoardTile';
import { BoardFormFields, extractBoardFormValues } from '../forms/BoardFormFields';
import { HighlightMatch } from '../HighlightMatch';
import { JSONEditor, validateJSON } from '../JSONEditor';
import { ListPanelHeader } from './panelPrimitives';
import { SettingsActionGroup } from './SettingsActionGroup';
import { DrillInFrame, useSettingsDrill } from './SettingsDrill';

interface BoardsTableProps {
  client: AgorClient | null;
  boardById: Map<string, Board>;
  sessionsByBranch: Map<string, Session[]>;
  branchById: Map<string, Branch>;
  onCreate?: (board: Partial<Board>) => void;
  onUpdate?: (boardId: string, updates: Partial<Board>) => void;
  onDelete?: (boardId: string) => void;
  onArchive?: (boardId: string) => void;
  onUnarchive?: (boardId: string) => void;
}

export const BoardsTable: React.FC<BoardsTableProps> = ({
  client,
  boardById,
  sessionsByBranch,
  branchById,
  onCreate,
  onUpdate,
  onDelete,
  onArchive,
  onUnarchive,
}) => {
  const { modal } = App.useApp();
  const { showSuccess, showError } = useThemedMessage();
  const [rbacEnabled, setRbacEnabled] = useState(false);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [allGroups, setAllGroups] = useState<Group[]>([]);
  const [archiveFilter, setArchiveFilter] = useState<'active' | 'archived' | 'all'>('active');
  const [searchTerm, setSearchTerm] = useState('');
  const [dirty, setDirty] = useState(false);
  const [form] = Form.useForm();

  // Editing/creating swaps this section's Content pane for the drill-in editor
  // below, instead of stacking a second Modal on top of Settings.
  const { drill, openDrill, closeDrill } = useSettingsDrill();
  const editingBoard =
    drill?.kind === 'boards' && drill.mode === 'edit' && drill.recordId
      ? (boardById.get(drill.recordId) ?? null)
      : null;
  const isCreating = drill?.kind === 'boards' && drill.mode === 'create';

  const openEdit = useCallback(
    (board: Board) => openDrill({ kind: 'boards', mode: 'edit', recordId: board.board_id }),
    [openDrill]
  );
  const openCreate = useCallback(() => openDrill({ kind: 'boards', mode: 'create' }), [openDrill]);

  // Calculate session count per board (branch-centric model). Build the
  // board buckets once so opening Settings is O(branches + sessions) instead
  // of O(boards × branches).
  const boardSessionCounts = useMemo(() => {
    const counts = new Map<string, number>();

    for (const branch of branchById.values()) {
      if (!branch.board_id) continue;
      counts.set(
        branch.board_id,
        (counts.get(branch.board_id) ?? 0) + (sessionsByBranch.get(branch.branch_id)?.length ?? 0)
      );
    }

    for (const board of boardById.values()) {
      if (!counts.has(board.board_id)) counts.set(board.board_id, 0);
    }

    return counts;
  }, [boardById, sessionsByBranch, branchById]);

  const syncBoardPermissions = useCallback(
    async (boardId: string) => {
      if (!client || !rbacEnabled) return;
      const boardUuid = boardId as UUID;
      const values = form.getFieldsValue(true);
      const isPrivate = values.access_mode === 'private';
      const desiredOwnerIds = (values.owner_ids || []) as UUID[];
      const desiredGrants = (isPrivate ? [] : values.board_group_grants || []) as Array<{
        group_id: string;
        can: BranchPermissionLevel;
        fs_access?: BranchFsAccessLevel;
      }>;

      const currentOwners = (await client
        .service('boards/:id/owners')
        .find({ route: { id: boardUuid } })) as User[];
      const currentOwnerIds = currentOwners.map((u) => u.user_id as UUID);
      await Promise.all([
        ...desiredOwnerIds
          .filter((id) => !currentOwnerIds.includes(id))
          .map((user_id) =>
            client.service('boards/:id/owners').create({ user_id }, { route: { id: boardUuid } })
          ),
        ...currentOwnerIds
          .filter((id) => !desiredOwnerIds.includes(id))
          .map((id) =>
            client.service('boards/:id/owners').remove(id, { route: { id: boardUuid } })
          ),
      ]);

      const currentGrants = (await client
        .service('boards/:id/group-grants')
        .find({ route: { id: boardUuid } })) as BoardGroupGrantWithGroup[];
      const desiredByGroup = new Map(desiredGrants.map((grant) => [grant.group_id, grant]));
      await Promise.all([
        ...desiredGrants.map((grant) =>
          client.service('boards/:id/group-grants').create(grant, { route: { id: boardUuid } })
        ),
        ...currentGrants
          .filter((grant) => !desiredByGroup.has(grant.group_id))
          .map((grant) =>
            client.service('boards/:id/group-grants').remove(grant.group_id, {
              route: { id: boardUuid },
            })
          ),
      ]);
    },
    [client, rbacEnabled, form]
  );

  // Seed the form (and load RBAC metadata) whenever the drill-in targets a
  // board to edit. Mirrors the old handleEdit's async owner/grant fetch.
  useEffect(() => {
    if (!editingBoard) return;
    let cancelled = false;

    const seed = async () => {
      let ownerIds: string[] = [];
      let boardGroupGrants: Array<{ group_id: string; can: string; fs_access?: string }> = [];
      if (client) {
        try {
          const [users, groups, owners, grants] = await Promise.all([
            client.service('users').findAll({}),
            client.service('groups').findAll({ query: { archived: false } }),
            client.service('boards/:id/owners').find({ route: { id: editingBoard.board_id } }),
            client
              .service('boards/:id/group-grants')
              .find({ route: { id: editingBoard.board_id } }),
          ]);
          if (cancelled) return;
          setRbacEnabled(true);
          setAllUsers(users as User[]);
          setAllGroups(groups as Group[]);
          ownerIds = (owners as User[]).map((user) => user.user_id);
          if (ownerIds.length === 0 && editingBoard.created_by) {
            ownerIds = [editingBoard.created_by];
          }
          boardGroupGrants = (
            grants as Array<{ group_id: string; can: string; fs_access?: string }>
          ).map((grant) => ({
            group_id: grant.group_id,
            can: grant.can,
            fs_access: grant.fs_access,
          }));
        } catch (error) {
          if (cancelled) return;
          setRbacEnabled(false);
          setAllUsers([]);
          setAllGroups([]);
          console.warn('Board RBAC metadata unavailable:', error);
        }
      }
      if (cancelled) return;
      form.setFieldsValue({
        name: editingBoard.name,
        icon: editingBoard.icon,
        description: editingBoard.description,
        background_color: editingBoard.background_color,
        custom_css: editingBoard.custom_css,
        access_mode: editingBoard.access_mode || 'shared',
        default_others_can: editingBoard.default_others_can || 'session',
        default_others_fs_access: editingBoard.default_others_fs_access || 'read',
        default_dangerously_allow_session_sharing: Boolean(
          editingBoard.default_dangerously_allow_session_sharing
        ),
        owner_ids: ownerIds,
        board_group_grants: boardGroupGrants,
        custom_context: editingBoard.custom_context
          ? JSON.stringify(editingBoard.custom_context, null, 2)
          : '',
      });
      setDirty(false);
    };

    void seed();
    return () => {
      cancelled = true;
    };
  }, [editingBoard, client, form]);

  // Seed defaults when entering the create drill-in.
  useEffect(() => {
    if (!isCreating) return;
    form.resetFields();
    form.setFieldsValue({ background_color: GOLD_SHIMMER_BOARD_BACKGROUND });
    setDirty(false);
  }, [isCreating, form]);

  const handleCreate = useCallback(async () => {
    // Validate all fields (not just 'name') so custom_context JSON rules run.
    // Otherwise the extractor's JSON.parse can throw and get swallowed.
    await form.validateFields();
    onCreate?.(extractBoardFormValues(form));
    setDirty(false);
    closeDrill();
  }, [closeDrill, form, onCreate]);

  const handleUpdate = useCallback(async () => {
    if (!editingBoard) return;
    await form.validateFields();
    const values = form.getFieldsValue(true);
    if (values.access_mode === 'private' && (values.owner_ids || []).length !== 1) {
      showError('Private boards must have exactly one private user');
      return;
    }
    onUpdate?.(editingBoard.board_id, extractBoardFormValues(form));
    syncBoardPermissions(editingBoard.board_id).catch((error) => {
      showError(`Failed to update board permissions: ${error.message}`);
    });
    setDirty(false);
    closeDrill();
  }, [closeDrill, editingBoard, form, onUpdate, showError, syncBoardPermissions]);

  const handleDelete = (boardId: string) => {
    onDelete?.(boardId);
  };

  const handleClone = (board: Board) => {
    const defaultName = `${board.name} (Copy)`;
    let newName = defaultName;

    modal.confirm({
      title: 'Clone Board',
      content: (
        <Input
          placeholder="New board name"
          defaultValue={defaultName}
          onChange={(e) => {
            newName = e.target.value;
          }}
          onPressEnter={(e) => {
            e.preventDefault();
          }}
        />
      ),
      onOk: () => {
        if (!client) {
          showError('Not connected to daemon');
          return Promise.reject(new Error('Not connected to daemon'));
        }

        const boardsService = client.service('boards');
        return boardsService
          .clone({ id: board.board_id, name: newName })
          .then((clonedBoard) => {
            showSuccess(`Board cloned: ${clonedBoard.name}`);
            onCreate?.(clonedBoard);
          })
          .catch((error) => {
            showError(`Clone failed: ${error instanceof Error ? error.message : String(error)}`);
            return Promise.reject(error);
          });
      },
    });
  };

  const handleExport = async (board: Board) => {
    if (!client) {
      showError('Not connected to daemon');
      return;
    }
    try {
      const boardsService = client.service('boards');
      const yaml = await boardsService.toYaml({ id: board.board_id });

      const blob = new Blob([yaml], { type: 'text/yaml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${board.slug || board.name.toLowerCase().replace(/\s+/g, '-')}.agor-board.yaml`;
      a.click();
      URL.revokeObjectURL(url);

      showSuccess('Board exported');
    } catch (error) {
      showError(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleImportClick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.yaml,.yml,.json';
    input.onchange = (e) => handleImportFile((e.target as HTMLInputElement).files?.[0]);
    input.click();
  };

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return;
    if (!client) {
      showError('Not connected to daemon');
      return;
    }

    const content = await file.text();

    try {
      const boardsService = client.service('boards');
      let board: Board;

      if (file.name.endsWith('.json')) {
        board = await boardsService.fromBlob(JSON.parse(content));
      } else {
        board = await boardsService.fromYaml({ yaml: content });
      }

      showSuccess(`Board imported: ${board.name}`);
      onCreate?.(board);
    } catch (error) {
      showError(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const customContextField = (
    <Form.Item
      label="Custom Context (JSON)"
      name="custom_context"
      help="Add custom fields for use in zone trigger templates (e.g., {{ board.context.yourField }})"
      rules={[{ validator: validateJSON }]}
    >
      <JSONEditor placeholder='{"team": "Backend", "sprint": 42}' rows={4} />
    </Form.Item>
  );

  // Pre-search active list (post archive-filter) so the list can distinguish a
  // "no boards yet" empty state from a "search matched nothing" one.
  const activeBoards = useMemo(
    () =>
      mapToSortedArray(boardById, (a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      ).filter((board) => {
        if (archiveFilter === 'active') return !board.archived;
        if (archiveFilter === 'archived') return board.archived;
        return true;
      }),
    [boardById, archiveFilter]
  );

  const boards = useMemo(
    () =>
      filterBySettingsSearch(activeBoards, searchTerm, [
        (board) => board.name,
        (board) => board.slug,
        (board) => board.description,
        (board) => board.board_id,
      ]),
    [activeBoards, searchTerm]
  );

  const columns = [
    {
      title: 'Board',
      key: 'tile',
      width: 80,
      render: (_: unknown, board: Board) => (
        <BoardTile emoji={getBoardEmoji(board, branchById)} size={32} />
      ),
    },
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, board: Board) => (
        <Typography.Link ellipsis title={name} onClick={() => openEdit(board)}>
          <HighlightMatch text={name} query={searchTerm} />
        </Typography.Link>
      ),
    },
    {
      title: 'Description',
      dataIndex: 'description',
      key: 'description',
      render: (desc: string) => (
        <Typography.Text type="secondary">
          {desc ? <HighlightMatch text={desc} query={searchTerm} /> : '—'}
        </Typography.Text>
      ),
    },
    {
      title: 'Sessions',
      key: 'sessions',
      width: 100,
      render: (_: unknown, board: Board) => boardSessionCounts.get(board.board_id) || 0,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 184,
      render: (_: unknown, board: Board) => (
        <SettingsActionGroup>
          <ArchiveToggleButton
            archived={Boolean(board.archived)}
            tooltip={board.archived ? 'Archived • Click to unarchive' : 'Archive board'}
            stopPropagation={false}
            onToggle={(nextArchived) => {
              if (nextArchived) {
                onArchive?.(board.board_id);
              } else {
                onUnarchive?.(board.board_id);
              }
            }}
          />
          <Tooltip title="Clone board (zones, configuration, and positions only)">
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              onClick={() => handleClone(board)}
            />
          </Tooltip>
          <Tooltip title="Export board to YAML (zones, configuration, and positions only)">
            <Button
              type="text"
              size="small"
              icon={<DownloadOutlined />}
              onClick={() => handleExport(board)}
            />
          </Tooltip>
          <Tooltip title="Edit board settings">
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={() => openEdit(board)}
            />
          </Tooltip>
          <Popconfirm
            title="Delete board?"
            description={`Are you sure you want to delete "${board.name}"? Sessions will not be deleted.`}
            onConfirm={() => handleDelete(board.board_id)}
            okText="Delete"
            cancelText="Cancel"
            okButtonProps={{ danger: true }}
          >
            <Tooltip title="Delete board (sessions will not be deleted)">
              <Button type="text" size="small" icon={<DeleteOutlined />} danger />
            </Tooltip>
          </Popconfirm>
        </SettingsActionGroup>
      ),
    },
  ];

  if (editingBoard || isCreating) {
    return (
      <DrillInFrame
        title={editingBoard ? `Edit ${editingBoard.name}` : 'New Board'}
        dirty={dirty}
        onSave={editingBoard ? handleUpdate : handleCreate}
        saveLabel={editingBoard ? undefined : 'Create'}
      >
        {/* Full width (no maxWidth) so BoardFormFields' Tabs span the pane
            instead of sitting in a narrow cluster. */}
        <Form form={form} layout="vertical" onValuesChange={() => setDirty(true)}>
          {editingBoard ? (
            <BoardFormFields
              // Keyed on board_id so the background editor and Collapse
              // defaultActiveKey re-initialize when switching between boards;
              // backgroundResetSignal re-syncs its mode from the loaded values.
              key={editingBoard.board_id}
              form={form}
              extra={customContextField}
              backgroundResetSignal={editingBoard.board_id}
              rbacEnabled={rbacEnabled}
              allUsers={allUsers}
              allGroups={allGroups}
            />
          ) : (
            <BoardFormFields form={form} extra={customContextField} />
          )}
        </Form>
      </DrillInFrame>
    );
  }

  return (
    <div>
      <ListPanelHeader
        title="Boards"
        description="Create and manage boards for organizing sessions."
        search={
          <Space>
            <Select
              value={archiveFilter}
              onChange={(value) => setArchiveFilter(value)}
              style={{ width: 120 }}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'all', label: 'All' },
                { value: 'archived', label: 'Archived' },
              ]}
            />
            <Input
              allowClear
              placeholder="Search name, slug, description, or ID"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              style={{ width: 300 }}
            />
          </Space>
        }
        actions={
          <>
            <Button icon={<UploadOutlined />} onClick={handleImportClick}>
              Import Board
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              New Board
            </Button>
          </>
        }
      />

      {boards.length === 0 ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 400,
          }}
        >
          {activeBoards.length === 0 ? (
            <Empty description="No boards yet">
              <Typography.Text type="secondary">
                Create a board to start organizing sessions.
              </Typography.Text>
            </Empty>
          ) : (
            <Empty description={`No boards match “${searchTerm}”`} />
          )}
        </div>
      ) : (
        <Table
          dataSource={boards}
          columns={columns}
          rowKey="board_id"
          pagination={false}
          size="small"
          onRow={(record) => ({
            style: record.archived ? { opacity: 0.5 } : undefined,
          })}
        />
      )}
    </div>
  );
};
