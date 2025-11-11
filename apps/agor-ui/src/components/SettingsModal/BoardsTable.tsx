import type { Board, Session, Worktree } from '@agor/core/types';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Button,
  ColorPicker,
  Flex,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Typography,
} from 'antd';
import type { Color } from 'antd/es/color-picker';
import { useMemo, useState } from 'react';
import { FormEmojiPickerInput } from '../EmojiPickerInput';
import { JSONEditor, validateJSON } from '../JSONEditor';

// Using Typography.Text directly to avoid DOM Text interface collision

interface BoardsTableProps {
  boards: Board[];
  sessions: Session[];
  worktrees: Worktree[];
  onCreate?: (board: Partial<Board>) => void;
  onUpdate?: (boardId: string, updates: Partial<Board>) => void;
  onDelete?: (boardId: string) => void;
}

export const BoardsTable: React.FC<BoardsTableProps> = ({
  boards,
  sessions,
  worktrees,
  onCreate,
  onUpdate,
  onDelete,
}) => {
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingBoard, setEditingBoard] = useState<Board | null>(null);
  const [form] = Form.useForm();

  // Calculate session count per board (worktree-centric model)
  const boardSessionCounts = useMemo(() => {
    const counts = new Map<string, number>();

    boards.forEach(board => {
      // Get worktrees for this board
      const boardWorktrees = worktrees.filter(wt => wt.board_id === board.board_id);
      const boardWorktreeIds = new Set(boardWorktrees.map(wt => wt.worktree_id));

      // Count sessions for these worktrees
      const sessionCount = sessions.filter(
        session => session.worktree_id && boardWorktreeIds.has(session.worktree_id)
      ).length;

      counts.set(board.board_id, sessionCount);
    });

    return counts;
  }, [boards, sessions, worktrees]);

  const handleCreate = () => {
    form.validateFields().then(values => {
      onCreate?.({
        name: values.name,
        icon: values.icon || '📋',
        description: values.description,
        background_color: values.background_color
          ? typeof values.background_color === 'string'
            ? values.background_color
            : values.background_color.toHexString()
          : undefined,
        custom_context: values.custom_context ? JSON.parse(values.custom_context) : undefined,
      });
      form.resetFields();
      setCreateModalOpen(false);
    });
  };

  const handleEdit = (board: Board) => {
    setEditingBoard(board);
    form.setFieldsValue({
      name: board.name,
      icon: board.icon,
      description: board.description,
      background_color: board.background_color,
      custom_context: board.custom_context ? JSON.stringify(board.custom_context, null, 2) : '',
    });
    setEditModalOpen(true);
  };

  const handleUpdate = () => {
    if (!editingBoard) return;

    form.validateFields().then(values => {
      onUpdate?.(editingBoard.board_id, {
        name: values.name,
        icon: values.icon,
        description: values.description,
        background_color: values.background_color
          ? typeof values.background_color === 'string'
            ? values.background_color
            : values.background_color.toHexString()
          : undefined,
        custom_context: values.custom_context ? JSON.parse(values.custom_context) : undefined,
      });
      form.resetFields();
      setEditModalOpen(false);
      setEditingBoard(null);
    });
  };

  const handleDelete = (boardId: string) => {
    onDelete?.(boardId);
  };

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
      width: 120,
      render: (_: unknown, board: Board) => (
        <Space size="small">
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            onClick={() => handleEdit(board)}
          />
          <Popconfirm
            title="Delete board?"
            description={`Are you sure you want to delete "${board.name}"? Sessions will not be deleted.`}
            onConfirm={() => handleDelete(board.board_id)}
            okText="Delete"
            cancelText="Cancel"
            okButtonProps={{ danger: true }}
          >
            <Button type="text" size="small" icon={<DeleteOutlined />} danger />
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
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalOpen(true)}>
          New Board
        </Button>
      </div>

      <Table
        dataSource={boards}
        columns={columns}
        rowKey="board_id"
        pagination={false}
        size="small"
      />

      {/* Create Board Modal */}
      <Modal
        title="Create Board"
        open={createModalOpen}
        onOk={handleCreate}
        onCancel={() => {
          form.resetFields();
          setCreateModalOpen(false);
        }}
        okText="Create"
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            label="Name"
            rules={[{ required: true, message: 'Please enter a board name' }]}
            style={{ marginBottom: 24 }}
          >
            <Flex gap={8}>
              <Form.Item name="icon" noStyle>
                <FormEmojiPickerInput form={form} fieldName="icon" defaultEmoji="📋" />
              </Form.Item>
              <Form.Item name="name" noStyle style={{ flex: 1 }}>
                <Input placeholder="My Board" style={{ flex: 1 }} />
              </Form.Item>
            </Flex>
          </Form.Item>

          <Form.Item label="Description" name="description">
            <Input.TextArea placeholder="Optional description..." rows={3} />
          </Form.Item>

          <Form.Item
            label="Background Color"
            name="background_color"
            help="Set a custom background color for the board canvas"
          >
            <ColorPicker showText format="hex" />
          </Form.Item>

          <Form.Item
            label="Custom Context (JSON)"
            name="custom_context"
            help="Add custom fields for use in zone trigger templates (e.g., {{ board.context.yourField }})"
            rules={[{ validator: validateJSON }]}
          >
            <JSONEditor placeholder='{"team": "Backend", "sprint": 42}' rows={4} />
          </Form.Item>
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
        }}
        okText="Save"
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            label="Name"
            rules={[{ required: true, message: 'Please enter a board name' }]}
            style={{ marginBottom: 24 }}
          >
            <Flex gap={8}>
              <Form.Item name="icon" noStyle>
                <FormEmojiPickerInput form={form} fieldName="icon" defaultEmoji="📋" />
              </Form.Item>
              <Form.Item name="name" noStyle style={{ flex: 1 }}>
                <Input placeholder="My Board" style={{ flex: 1 }} />
              </Form.Item>
            </Flex>
          </Form.Item>

          <Form.Item label="Description" name="description">
            <Input.TextArea placeholder="Optional description..." rows={3} />
          </Form.Item>

          <Form.Item
            label="Background Color"
            name="background_color"
            help="Set a custom background color for the board canvas"
          >
            <ColorPicker showText format="hex" />
          </Form.Item>

          <Form.Item
            label="Custom Context (JSON)"
            name="custom_context"
            help="Add custom fields for use in zone trigger templates (e.g., {{ board.context.yourField }})"
            rules={[{ validator: validateJSON }]}
          >
            <JSONEditor placeholder='{"team": "Backend", "sprint": 42}' rows={4} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};
