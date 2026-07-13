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
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tooltip,
  Typography,
} from 'antd';
import { useMemo, useState } from 'react';
import { mapToSortedArray } from '@/utils/mapHelpers';
import { useThemedMessage } from '@/utils/message';
import { filterBySettingsSearch } from '@/utils/settingsSearch';
import { ArchiveToggleButton } from '../ArchiveButton';
import { BoardFormFields, extractBoardFormValues, isCustomCSS } from '../forms/BoardFormFields';
import { HighlightMatch } from '../HighlightMatch';
import { JSONEditor, validateJSON } from '../JSONEditor';
import { SettingsActionGroup } from './SettingsActionGroup';

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
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingBoard, setEditingBoard] = useState<Board | null>(null);
  const [rbacEnabled, setRbacEnabled] = useState(false);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [allGroups, setAllGroups] = useState<Group[]>([]);
  const [archiveFilter, setArchiveFilter] = useState<'active' | 'archived' | 'all'>('active');
  const [searchTerm, setSearchTerm] = useState('');
  const [form] = Form.useForm();

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

  const syncBoardPermissions = async (boardId: string) => {
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
        .map((id) => client.service('boards/:id/owners').remove(id, { route: { id: boardUuid } })),
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
  };

  const handleCreate = () => {
    // Validate all fields (not just 'name') so custom_context JSON rules run.
    // Otherwise the extractor's JSON.parse can throw and get swallowed.
    form
      .validateFields()
      .then(() => {
        onCreate?.(extractBoardFormValues(form));
        form.resetFields();
        setCreateModalOpen(false);
      })
      .catch(() => {
        // Antd displays inline field errors; nothing to do here.
      });
  };

  const handleEdit = async (board: Board) => {
    setEditingBoard(board);
    let ownerIds: string[] = [];
    let boardGroupGrants: Array<{ group_id: string; can: string; fs_access?: string }> = [];
    if (client) {
      try {
        const [users, groups, owners, grants] = await Promise.all([
          client.service('users').findAll({}),
          client.service('groups').findAll({ query: { archived: false } }),
          client.service('boards/:id/owners').find({ route: { id: board.board_id } }),
          client.service('boards/:id/group-grants').find({ route: { id: board.board_id } }),
        ]);
        setRbacEnabled(true);
        setAllUsers(users as User[]);
        setAllGroups(groups as Group[]);
        ownerIds = (owners as User[]).map((user) => user.user_id);
        if (ownerIds.length === 0 && board.created_by) {
          ownerIds = [board.created_by];
        }
        boardGroupGrants = (
          grants as Array<{ group_id: string; can: string; fs_access?: string }>
        ).map((grant) => ({
          group_id: grant.group_id,
          can: grant.can,
          fs_access: grant.fs_access,
        }));
      } catch (error) {
        setRbacEnabled(false);
        setAllUsers([]);
        setAllGroups([]);
        console.warn('Board RBAC metadata unavailable:', error);
      }
    }
    form.setFieldsValue({
      name: board.name,
      icon: board.icon,
      description: board.description,
      background_color: board.background_color,
      custom_css: board.custom_css,
      access_mode: board.access_mode || 'shared',
      default_others_can: board.default_others_can || 'session',
      default_others_fs_access: board.default_others_fs_access || 'read',
      default_dangerously_allow_session_sharing: Boolean(
        board.default_dangerously_allow_session_sharing
      ),
      owner_ids: ownerIds,
      board_group_grants: boardGroupGrants,
      custom_context: board.custom_context ? JSON.stringify(board.custom_context, null, 2) : '',
    });
    setEditModalOpen(true);
  };

  const handleUpdate = () => {
    if (!editingBoard) return;

    form
      .validateFields()
      .then(() => {
        const values = form.getFieldsValue(true);
        if (values.access_mode === 'private' && (values.owner_ids || []).length !== 1) {
          showError('Private boards must have exactly one private user');
          return;
        }
        onUpdate?.(editingBoard.board_id, extractBoardFormValues(form));
        syncBoardPermissions(editingBoard.board_id).catch((error) => {
          showError(`Failed to update board permissions: ${error.message}`);
        });
        form.resetFields();
        setEditModalOpen(false);
        setEditingBoard(null);
      })
      .catch(() => {
        // Antd displays inline field errors; nothing to do here.
      });
  };

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

  const boards = useMemo(() => {
    const filteredByArchive = mapToSortedArray(boardById, (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    ).filter((board) => {
      if (archiveFilter === 'active') return !board.archived;
      if (archiveFilter === 'archived') return board.archived;
      return true;
    });

    return filterBySettingsSearch(filteredByArchive, searchTerm, [
      (board) => board.name,
      (board) => board.slug,
      (board) => board.description,
      (board) => board.board_id,
    ]);
  }, [boardById, archiveFilter, searchTerm]);

  const columns = [
    {
      title: 'Icon',
      dataIndex: 'icon',
      key: 'icon',
      width: 80,
      render: (icon: string) => <span style={{ fontSize: 24 }}>{icon || '📋'}</span>,
    },
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => <HighlightMatch text={name} query={searchTerm} />,
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
              onClick={() => handleEdit(board)}
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
          Create and manage boards for organizing sessions.
        </Typography.Text>
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
          <Button icon={<UploadOutlined />} onClick={handleImportClick}>
            Import Board
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              form.resetFields();
              form.setFieldsValue({ background_color: GOLD_SHIMMER_BOARD_BACKGROUND });
              setCreateModalOpen(true);
            }}
          >
            New Board
          </Button>
        </Space>
      </div>

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

      {/* Create Board Modal */}
      <Modal
        title="Create Board"
        open={createModalOpen}
        width={760}
        onOk={handleCreate}
        onCancel={() => {
          form.resetFields();
          setCreateModalOpen(false);
        }}
        okText="Create"
      >
        <Form form={form} layout="vertical" preserve style={{ marginTop: 16 }}>
          <BoardFormFields form={form} extra={customContextField} initialCustomCSS />
        </Form>
      </Modal>

      {/* Edit Board Modal */}
      <Modal
        title="Edit Board"
        open={editModalOpen}
        width={760}
        onOk={handleUpdate}
        onCancel={() => {
          form.resetFields();
          setEditModalOpen(false);
          setEditingBoard(null);
        }}
        okText="Save"
      >
        <Form form={form} layout="vertical" preserve style={{ marginTop: 16 }}>
          {/* Keyed on board_id so useCustomCSS state and Collapse defaultActiveKey
              re-initialize when switching between boards (Modal stays mounted). */}
          <BoardFormFields
            key={editingBoard?.board_id}
            form={form}
            extra={customContextField}
            initialCustomCSS={
              isCustomCSS(editingBoard?.background_color) || Boolean(editingBoard?.custom_css)
            }
            rbacEnabled={rbacEnabled}
            allUsers={allUsers}
            allGroups={allGroups}
          />
        </Form>
      </Modal>
    </div>
  );
};
