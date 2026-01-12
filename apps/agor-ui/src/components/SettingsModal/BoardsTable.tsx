import type { AgorClient } from '@agor/core/api';
import type { Board, Session, Worktree } from '@agor/core/types';
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
  Checkbox,
  ColorPicker,
  Flex,
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
import { FormEmojiPickerInput } from '../EmojiPickerInput';
import { JSONEditor, validateJSON } from '../JSONEditor';

// Using Typography.Text directly to avoid DOM Text interface collision

// Background presets
const BACKGROUND_PRESETS = [
  {
    label: 'Rainbow (7 colors)',
    value:
      'linear-gradient(to right, #ff0000, #ff7f00, #ffff00, #00ff00, #0000ff, #4b0082, #9400d3)',
  },
  {
    label: 'Multi-color gradient',
    value:
      'linear-gradient(124deg, #ff2400, #e81d1d, #e8b71d, #e3e81d, #1de840, #1ddde8, #2b1de8, #dd00f3, #dd00f3)',
  },
  {
    label: 'Pink to blue gradient',
    value:
      'linear-gradient(180deg, #f093fb 0%, #f5576c 25%, #4facfe 50%, #00f2fe 75%, #43e97b 100%)',
  },
  {
    label: 'Gold shimmer',
    value: 'linear-gradient(135deg, #f5af19 0%, #f12711 30%, #f5af19 60%, #f12711 100%)',
  },
  {
    label: 'Cyan/magenta grid',
    value:
      'repeating-linear-gradient(0deg, transparent, transparent 2px, #0ff 2px, #0ff 4px), repeating-linear-gradient(90deg, transparent, transparent 2px, #f0f 2px, #f0f 4px), linear-gradient(180deg, #000, #001a1a)',
  },
  {
    label: 'Diagonal stripes (colorful)',
    value:
      'repeating-linear-gradient(45deg, #ff006e 0px, #ff006e 10px, #ffbe0b 10px, #ffbe0b 20px, #8338ec 20px, #8338ec 30px, #3a86ff 30px, #3a86ff 40px)',
  },
  {
    label: 'Conic gradient (warm colors)',
    value:
      'conic-gradient(from 45deg, #ff0080, #ff8c00, #40e0d0, #ff0080, #ff8c00, #40e0d0, #ff0080)',
  },
  {
    label: 'Dark with purple/pink spots',
    value:
      'radial-gradient(ellipse at top, #1b2735 0%, #090a0f 100%), radial-gradient(circle at 20% 50%, rgba(120, 0, 255, 0.3) 0%, transparent 50%), radial-gradient(circle at 80% 80%, rgba(255, 0, 120, 0.3) 0%, transparent 50%)',
  },
  {
    label: 'Quadrant blocks (conic)',
    value:
      'repeating-conic-gradient(from 0deg at 50% 50%, #ff006e 0deg 90deg, #8338ec 90deg 180deg, #3a86ff 180deg 270deg, #fb5607 270deg 360deg)',
  },
  {
    label: 'RGB stripes',
    value:
      'linear-gradient(90deg, #000 0%, #f00 20%, #000 21%, #0f0 40%, #000 41%, #00f 60%, #000 61%, #fff 80%, #000 81%)',
  },
  {
    label: 'Fine diagonal lines (B&W)',
    value: 'repeating-linear-gradient(45deg, #000, #000 1px, #fff 1px, #fff 2px)',
  },
  {
    label: 'Dark with magenta/cyan glow',
    value:
      'radial-gradient(circle at 30% 50%, rgba(255, 0, 255, 0.5), transparent 50%), radial-gradient(circle at 70% 70%, rgba(0, 255, 255, 0.5), transparent 50%), linear-gradient(180deg, #0a0a0a, #1a1a2e)',
  },
  {
    label: 'Sunburst (conic)',
    value:
      'conic-gradient(from 0deg, #ffbe0b 0deg, #fb5607 60deg, #ff006e 120deg, #8338ec 180deg, #3a86ff 240deg, #ffbe0b 300deg, #fb5607 360deg)',
  },
  {
    label: 'Checkerboard (purple)',
    value: 'repeating-linear-gradient(45deg, #606dbc, #606dbc 10px, #465298 10px, #465298 20px)',
  },
];

interface BoardsTableProps {
  client: AgorClient | null;
  boardById: Map<string, Board>;
  sessionsByWorktree: Map<string, Session[]>; // O(1) worktree filtering
  worktreeById: Map<string, Worktree>;
  onCreate?: (board: Partial<Board>) => void;
  onUpdate?: (boardId: string, updates: Partial<Board>) => void;
  onDelete?: (boardId: string) => void;
}

export const BoardsTable: React.FC<BoardsTableProps> = ({
  client,
  boardById,
  sessionsByWorktree,
  worktreeById,
  onCreate,
  onUpdate,
  onDelete,
}) => {
  const { modal } = App.useApp();
  const { showSuccess, showError } = useThemedMessage();
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingBoard, setEditingBoard] = useState<Board | null>(null);
  const [useCustomCSSCreate, setUseCustomCSSCreate] = useState(false);
  const [useCustomCSSEdit, setUseCustomCSSEdit] = useState(false);
  const [form] = Form.useForm();

  // Helper to detect if a background value is custom CSS (not a simple hex color)
  const isCustomCSS = (value: string | undefined): boolean => {
    if (!value) return false;
    // Simple hex colors like #ffffff or rgb/rgba are not custom CSS
    // Everything else (gradients, patterns) is custom CSS
    return !value.match(/^#[0-9a-fA-F]{3,8}$/) && !value.match(/^rgba?\(/);
  };

  // Calculate session count per board (worktree-centric model)
  const boardSessionCounts = useMemo(() => {
    const counts = new Map<string, number>();

    for (const board of boardById.values()) {
      // Get worktree IDs for this board by iterating the Map
      const boardWorktreeIds: string[] = [];
      for (const worktree of worktreeById.values()) {
        if (worktree.board_id === board.board_id) {
          boardWorktreeIds.push(worktree.worktree_id);
        }
      }

      // Count sessions for these worktrees using O(1) Map lookups
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

  // Clone board (inline prompt for new name)
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

        // Call service method directly
        const boardsService = client.service('boards');
        return boardsService
          .clone({ id: board.board_id, name: newName })
          .then((clonedBoard) => {
            showSuccess(`Board cloned: ${clonedBoard.name}`);
            // Trigger parent refresh by calling onCreate
            onCreate?.(clonedBoard);
          })
          .catch((error) => {
            showError(`Clone failed: ${error instanceof Error ? error.message : String(error)}`);
            return Promise.reject(error);
          });
      },
    });
  };

  // Export board (download YAML file)
  const handleExport = async (board: Board) => {
    if (!client) {
      showError('Not connected to daemon');
      return;
    }
    try {
      // Call service method directly
      const boardsService = client.service('boards');
      const yaml = await boardsService.toYaml({ id: board.board_id });

      // Trigger download
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

  // Import board (file picker dialog)
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
        // Import from JSON blob
        board = await boardsService.fromBlob(JSON.parse(content));
      } else {
        // Import from YAML
        board = await boardsService.fromYaml({ yaml: content });
      }

      showSuccess(`Board imported: ${board.name}`);
      // Trigger parent refresh by calling onCreate
      onCreate?.(board);
    } catch (error) {
      showError(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
      width: 240,
      render: (_: unknown, board: Board) => (
        <Space size="small">
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
        )}
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
          setUseCustomCSSCreate(false);
        }}
        okText="Create"
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label="Name" style={{ marginBottom: 24 }}>
            <Flex gap={8}>
              <Form.Item name="icon" noStyle>
                <FormEmojiPickerInput form={form} fieldName="icon" defaultEmoji="📋" />
              </Form.Item>
              <Form.Item
                name="name"
                noStyle
                style={{ flex: 1 }}
                rules={[{ required: true, message: 'Please enter a board name' }]}
              >
                <Input placeholder="My Board" style={{ flex: 1 }} />
              </Form.Item>
            </Flex>
          </Form.Item>

          <Form.Item label="Description" name="description">
            <Input.TextArea placeholder="Optional description..." rows={3} />
          </Form.Item>

          <Form.Item label="Background">
            <Space direction="vertical" style={{ width: '100%' }}>
              <Checkbox
                checked={useCustomCSSCreate}
                onChange={(e) => {
                  setUseCustomCSSCreate(e.target.checked);
                  if (e.target.checked) {
                    // Clear the color picker value when switching to custom CSS
                    form.setFieldsValue({ background_color: undefined });
                  }
                }}
              >
                Use custom CSS background
              </Checkbox>

              {!useCustomCSSCreate ? (
                <Form.Item name="background_color" noStyle>
                  <ColorPicker showText format="hex" allowClear />
                </Form.Item>
              ) : (
                <>
                  <Select
                    placeholder="Load a preset..."
                    style={{ width: '100%', marginBottom: 8 }}
                    allowClear
                    showSearch
                    options={BACKGROUND_PRESETS}
                    onChange={(value) => {
                      if (value) {
                        form.setFieldsValue({ background_color: value });
                      }
                    }}
                  />
                  <Form.Item name="background_color" noStyle>
                    <Input.TextArea
                      placeholder="Enter custom CSS or select a preset above"
                      rows={3}
                      style={{ fontFamily: 'monospace', fontSize: '12px' }}
                    />
                  </Form.Item>
                </>
              )}

              <Typography.Text
                type="secondary"
                style={{ fontSize: '12px', display: 'block', marginTop: 4 }}
              >
                {!useCustomCSSCreate
                  ? 'Set a solid background color for the board canvas'
                  : 'Choose a preset or enter any valid CSS background property (gradients, patterns, etc.)'}
              </Typography.Text>
            </Space>
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
          setUseCustomCSSEdit(false);
        }}
        okText="Save"
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label="Name" style={{ marginBottom: 24 }}>
            <Flex gap={8}>
              <Form.Item name="icon" noStyle>
                <FormEmojiPickerInput form={form} fieldName="icon" defaultEmoji="📋" />
              </Form.Item>
              <Form.Item
                name="name"
                noStyle
                style={{ flex: 1 }}
                rules={[{ required: true, message: 'Please enter a board name' }]}
              >
                <Input placeholder="My Board" style={{ flex: 1 }} />
              </Form.Item>
            </Flex>
          </Form.Item>

          <Form.Item label="Description" name="description">
            <Input.TextArea placeholder="Optional description..." rows={3} />
          </Form.Item>

          <Form.Item label="Background">
            <Space direction="vertical" style={{ width: '100%' }}>
              <Checkbox
                checked={useCustomCSSEdit}
                onChange={(e) => {
                  setUseCustomCSSEdit(e.target.checked);
                  if (e.target.checked) {
                    // Clear the color picker value when switching to custom CSS
                    form.setFieldsValue({ background_color: undefined });
                  }
                }}
              >
                Use custom CSS background
              </Checkbox>

              {!useCustomCSSEdit ? (
                <Form.Item name="background_color" noStyle>
                  <ColorPicker showText format="hex" allowClear />
                </Form.Item>
              ) : (
                <>
                  <Select
                    placeholder="Load a preset..."
                    style={{ width: '100%', marginBottom: 8 }}
                    allowClear
                    showSearch
                    options={BACKGROUND_PRESETS}
                    onChange={(value) => {
                      if (value) {
                        form.setFieldsValue({ background_color: value });
                      }
                    }}
                  />
                  <Form.Item name="background_color" noStyle>
                    <Input.TextArea
                      placeholder="Enter custom CSS or select a preset above"
                      rows={3}
                      style={{ fontFamily: 'monospace', fontSize: '12px' }}
                    />
                  </Form.Item>
                </>
              )}

              <Typography.Text
                type="secondary"
                style={{ fontSize: '12px', display: 'block', marginTop: 4 }}
              >
                {!useCustomCSSEdit
                  ? 'Set a solid background color for the board canvas'
                  : 'Choose a preset or enter any valid CSS background property (gradients, patterns, etc.)'}
              </Typography.Text>
            </Space>
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
