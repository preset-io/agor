import type { AgorClient, Board, Session, Worktree } from '@agor-live/client';
import {
  CodeSandboxOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  DropboxOutlined,
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
  theme,
} from 'antd';
import { useMemo, useState } from 'react';
import { mapToSortedArray } from '@/utils/mapHelpers';
import { useThemedMessage } from '@/utils/message';
import { BoardFormFields } from '../forms/BoardFormFields';
import { JSONEditor, validateJSON } from '../JSONEditor';

interface BoardsTableProps {
  client: AgorClient | null;
  boardById: Map<string, Board>;
  sessionsByWorktree: Map<string, Session[]>;
  worktreeById: Map<string, Worktree>;
  onCreate?: (board: Partial<Board>) => void;
  onUpdate?: (boardId: string, updates: Partial<Board>) => void;
  onDelete?: (boardId: string) => void;
  onArchive?: (boardId: string) => void;
  onUnarchive?: (boardId: string) => void;
}

export const BoardsTable: React.FC<BoardsTableProps> = ({
  client,
  boardById,
  sessionsByWorktree,
  worktreeById,
  onCreate,
  onUpdate,
  onDelete,
  onArchive,
  onUnarchive,
}) => {
  const { modal } = App.useApp();
  const { showSuccess, showError } = useThemedMessage();
  const { token } = theme.useToken();
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingBoard, setEditingBoard] = useState<Board | null>(null);
  const [useCustomCSSCreate, setUseCustomCSSCreate] = useState(false);
  const [useCustomCSSEdit, setUseCustomCSSEdit] = useState(false);
  const [archiveFilter, setArchiveFilter] = useState<'active' | 'archived' | 'all'>('active');
  const [hoveredArchiveButton, setHoveredArchiveButton] = useState<string | null>(null);
  const [form] = Form.useForm();

  // Helper to detect if a background value is custom CSS (not a simple hex color)
  const isCustomCSS = (value: string | undefined): boolean => {
    if (!value) return false;
    return !value.match(/^#[0-9a-fA-F]{3,8}$/) && !value.match(/^rgba?\(/);
  };

  // Calculate session count per board (worktree-centric model)
  const boardSessionCounts = useMemo(() => {
    const counts = new Map<string, number>();

    for (const board of boardById.values()) {
      const boardWorktreeIds: string[] = [];
      for (const worktree of worktreeById.values()) {
        if (worktree.board_id === board.board_id) {
          boardWorktreeIds.push(worktree.worktree_id);
        }
      }

      const sessionCount = boardWorktreeIds.flatMap(
        (worktreeId) => sessionsByWorktree.get(worktreeId) || []
      ).length;

      counts.set(board.board_id, sessionCount);
    }

    return counts;
  }, [boardById, sessionsByWorktree, worktreeById]);

  const handleCreate = () => {
    form.validateFields().then((values) => {
      onCreate?.({
        name: values.name,
        icon: values.icon || '📋',
        description: values.description,
        background_color: values.background_color
          ? typeof values.background_color === 'string'
            ? values.background_color
            : values.background_color.toHexString()
          : undefined,
        custom_css: values.custom_css || undefined,
        custom_context: values.custom_context ? JSON.parse(values.custom_context) : undefined,
      });
      form.resetFields();
      setCreateModalOpen(false);
      setUseCustomCSSCreate(false);
    });
  };

  const handleEdit = (board: Board) => {
    setEditingBoard(board);
    const hasCustomCSS = isCustomCSS(board.background_color);
    setUseCustomCSSEdit(hasCustomCSS);
    form.setFieldsValue({
      name: board.name,
      icon: board.icon,
      description: board.description,
      background_color: board.background_color,
      custom_css: board.custom_css,
      custom_context: board.custom_context ? JSON.stringify(board.custom_context, null, 2) : '',
    });
    setEditModalOpen(true);
  };

  const handleUpdate = () => {
    if (!editingBoard) return;

    form.validateFields().then((values) => {
      onUpdate?.(editingBoard.board_id, {
        name: values.name,
        icon: values.icon,
        description: values.description,
        background_color: values.background_color
          ? typeof values.background_color === 'string'
            ? values.background_color
            : values.background_color.toHexString()
          : undefined,
        custom_css: values.custom_css || undefined,
        custom_context: values.custom_context ? JSON.parse(values.custom_context) : undefined,
      });
      form.resetFields();
      setEditModalOpen(false);
      setEditingBoard(null);
      setUseCustomCSSEdit(false);
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
    },
    {
      title: 'Description',
      dataIndex: 'description',
      key: 'description',
      render: (desc: string) => <Typography.Text type="secondary">{desc || '—'}</Typography.Text>,
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
      width: 280,
      render: (_: unknown, board: Board) => (
        <Space size="small">
          <Tooltip title={board.archived ? 'Archived • Click to unarchive' : 'Click to archive'}>
            <Button
              type="text"
              size="small"
              icon={
                hoveredArchiveButton === board.board_id ? (
                  board.archived ? (
                    <DropboxOutlined style={{ color: token.colorSuccess }} />
                  ) : (
                    <CodeSandboxOutlined style={{ color: token.colorWarning }} />
                  )
                ) : board.archived ? (
                  <CodeSandboxOutlined style={{ color: token.colorWarning }} />
                ) : (
                  <DropboxOutlined style={{ color: token.colorTextSecondary }} />
                )
              }
              onMouseEnter={() => setHoveredArchiveButton(board.board_id)}
              onMouseLeave={() => setHoveredArchiveButton(null)}
              onClick={() => {
                if (board.archived) {
                  onUnarchive?.(board.board_id);
                } else {
                  onArchive?.(board.board_id);
                }
              }}
            />
          </Tooltip>
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
        </Space>
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
          <Button icon={<UploadOutlined />} onClick={handleImportClick}>
            Import Board
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalOpen(true)}>
            New Board
          </Button>
        </Space>
      </div>

      <Table
        dataSource={mapToSortedArray(boardById, (a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        ).filter((board) => {
          if (archiveFilter === 'active') return !board.archived;
          if (archiveFilter === 'archived') return board.archived;
          return true; // 'all'
        })}
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
        onOk={handleCreate}
        onCancel={() => {
          form.resetFields();
          setCreateModalOpen(false);
          setUseCustomCSSCreate(false);
        }}
        okText="Create"
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <BoardFormFields
            form={form}
            useCustomCSS={useCustomCSSCreate}
            onCustomCSSChange={setUseCustomCSSCreate}
            extra={customContextField}
          />
        </Form>
      </Modal>

      {/* Edit Board Modal */}
      <Modal
        title="Edit Board"
        open={editModalOpen}
        onOk={handleUpdate}
        onCancel={() => {
          form.resetFields();
          setEditModalOpen(false);
          setEditingBoard(null);
          setUseCustomCSSEdit(false);
        }}
        okText="Save"
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <BoardFormFields
            form={form}
            useCustomCSS={useCustomCSSEdit}
            onCustomCSSChange={setUseCustomCSSEdit}
            extra={customContextField}
          />
        </Form>
      </Modal>
    </div>
  );
};
