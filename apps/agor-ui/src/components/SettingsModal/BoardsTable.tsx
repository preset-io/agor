import type { AgorClient, Board, Branch, Session, User } from '@agor-live/client';
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
import { BoardEditModal } from '../BoardEditModal';
import { BoardTile, getBoardEmoji } from '../BoardTile';
import { BoardFormFields, extractBoardFormValues } from '../forms/BoardFormFields';
import { HighlightMatch } from '../HighlightMatch';
import { JSONEditor, validateJSON } from '../JSONEditor';
import { AdaptiveSettingsModal } from './AdaptiveSettingsModal';
import { ResponsiveSettingsHeader } from './ResponsiveSettingsHeader';
import { SettingsActionGroup } from './SettingsActionGroup';

interface BoardsTableProps {
  client: AgorClient | null;
  boardById: Map<string, Board>;
  sessionsByBranch: Map<string, Session[]>;
  branchById: Map<string, Branch>;
  currentUser?: User | null;
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
  currentUser,
  onCreate,
  onUpdate,
  onDelete,
  onArchive,
  onUnarchive,
}) => {
  const { modal } = App.useApp();
  const { showSuccess, showError } = useThemedMessage();
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editingBoard, setEditingBoard] = useState<Board | null>(null);
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

  const handleEdit = (board: Board) => setEditingBoard(board);

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
      <ResponsiveSettingsHeader
        description="Create and manage boards for organizing sessions."
        actions={(compact) => (
          <Space wrap style={{ width: compact ? '100%' : undefined }}>
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
              style={{ width: compact ? '100%' : 300, flex: compact ? '1 1 100%' : undefined }}
            />
            <Button icon={<UploadOutlined />} onClick={handleImportClick}>
              Import Board
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                // New boards start on the theme-aware default (no persisted
                // background); the editor's Default mode reflects this.
                form.resetFields();
                setCreateModalOpen(true);
              }}
            >
              New Board
            </Button>
          </Space>
        )}
      />

      <Table
        dataSource={boards}
        columns={columns}
        rowKey="board_id"
        pagination={false}
        size="small"
        scroll={{ x: 760 }}
        onRow={(record) => ({
          style: record.archived ? { opacity: 0.5 } : undefined,
        })}
      />

      {/* Create Board Modal */}
      <AdaptiveSettingsModal
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
          <BoardFormFields form={form} extra={customContextField} />
        </Form>
      </AdaptiveSettingsModal>

      <BoardEditModal
        board={editingBoard}
        client={client}
        open={Boolean(editingBoard)}
        onClose={() => setEditingBoard(null)}
        onUpdate={onUpdate}
        currentUser={currentUser}
      />
    </div>
  );
};
