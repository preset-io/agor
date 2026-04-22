import type { Artifact, Board, Worktree } from '@agor-live/client';
import { DeleteOutlined, EditOutlined } from '@ant-design/icons';
import {
  Badge,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useState } from 'react';
import { mapToArray, mapToSortedArray } from '@/utils/mapHelpers';

interface ArtifactsTableProps {
  artifactById: Map<string, Artifact>;
  worktreeById: Map<string, Worktree>;
  boardById: Map<string, Board>;
  onUpdate?: (artifactId: string, updates: Partial<Artifact>) => void;
  onDelete?: (artifactId: string) => void;
}

const templateColors: Record<string, string> = {
  react: 'cyan',
  'react-ts': 'blue',
  vanilla: 'green',
  'vanilla-ts': 'geekblue',
};

export const ArtifactsTable: React.FC<ArtifactsTableProps> = ({
  artifactById,
  worktreeById,
  boardById,
  onUpdate,
  onDelete,
}) => {
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingArtifact, setEditingArtifact] = useState<Artifact | null>(null);
  const [form] = Form.useForm();

  const handleEdit = (artifact: Artifact) => {
    setEditingArtifact(artifact);
    form.setFieldsValue({
      name: artifact.name,
      description: artifact.description || '',
      board_id: artifact.board_id,
    });
    setEditModalOpen(true);
  };

  const handleUpdate = () => {
    if (!editingArtifact) return;
    form.validateFields().then((values) => {
      // Build a patch of only fields that actually changed. If nothing
      // changed, skip the network round-trip entirely — avoids firing a
      // spurious `patched` broadcast for a no-op submit.
      const updates: Partial<Artifact> = {};
      const nextName = values.name;
      const nextDescription = values.description || undefined;
      const currentDescription = editingArtifact.description || undefined;
      if (nextName !== editingArtifact.name) updates.name = nextName;
      if (nextDescription !== currentDescription) updates.description = nextDescription;
      if (values.board_id && values.board_id !== editingArtifact.board_id) {
        updates.board_id = values.board_id;
      }
      if (Object.keys(updates).length > 0) {
        onUpdate?.(editingArtifact.artifact_id, updates);
      }
      form.resetFields();
      setEditModalOpen(false);
      setEditingArtifact(null);
    });
  };

  const boardOptions = mapToArray(boardById)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((board) => ({
      value: board.board_id,
      label: `${board.icon || '📋'} ${board.name}`,
    }));

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, artifact: Artifact) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{name}</Typography.Text>
          {artifact.description && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {artifact.description}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: 'Template',
      dataIndex: 'template',
      key: 'template',
      width: 120,
      render: (template: string) => (
        <Tag color={templateColors[template] || 'default'}>{template}</Tag>
      ),
    },
    {
      title: 'Build',
      dataIndex: 'build_status',
      key: 'build_status',
      width: 110,
      render: (status: Artifact['build_status']) => {
        const map: Record<
          string,
          { status: 'success' | 'error' | 'processing' | 'default'; text: string }
        > = {
          success: { status: 'success', text: 'Success' },
          error: { status: 'error', text: 'Error' },
          checking: { status: 'processing', text: 'Checking' },
          unknown: { status: 'default', text: 'Unknown' },
        };
        const info = map[status] || map.unknown;
        return <Badge status={info.status} text={info.text} />;
      },
    },
    {
      title: 'Worktree',
      dataIndex: 'worktree_id',
      key: 'worktree_id',
      width: 160,
      render: (worktreeId: string | null) => {
        if (!worktreeId) return <Typography.Text type="secondary">—</Typography.Text>;
        const worktree = worktreeById.get(worktreeId);
        return (
          <Typography.Text type="secondary">
            {worktree?.name || worktreeId.slice(0, 8)}
          </Typography.Text>
        );
      },
    },
    {
      title: 'Board',
      dataIndex: 'board_id',
      key: 'board_id',
      width: 160,
      render: (boardId: string) => {
        const board = boardById.get(boardId);
        return (
          <Typography.Text type="secondary">
            {board ? `${board.icon || ''} ${board.name}`.trim() : boardId.slice(0, 8)}
          </Typography.Text>
        );
      },
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 110,
      render: (date: string) => new Date(date).toLocaleDateString(),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 90,
      render: (_: unknown, artifact: Artifact) => (
        <Space size="small">
          <Tooltip title="Edit artifact">
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={() => handleEdit(artifact)}
            />
          </Tooltip>
          <Popconfirm
            title="Delete artifact?"
            description={`This will remove "${artifact.name}" and its files.`}
            onConfirm={() => onDelete?.(artifact.artifact_id)}
            okText="Delete"
            cancelText="Cancel"
            okButtonProps={{ danger: true }}
          >
            <Tooltip title="Delete artifact">
              <Button type="text" size="small" icon={<DeleteOutlined />} danger />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const dataSource = mapToSortedArray(artifactById, (a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  ).filter((artifact) => !artifact.archived);

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Typography.Text type="secondary">
          Live web application artifacts created by agents via MCP tools.
        </Typography.Text>
      </div>

      {dataSource.length === 0 ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 400,
          }}
        >
          <Empty description="No artifacts yet">
            <Typography.Text type="secondary">
              Artifacts are created by agents using the <code>agor_artifacts_publish</code> MCP
              tool.
            </Typography.Text>
          </Empty>
        </div>
      ) : (
        <Table
          dataSource={dataSource}
          columns={columns}
          rowKey="artifact_id"
          pagination={false}
          size="small"
        />
      )}

      <Modal
        title="Edit Artifact"
        open={editModalOpen}
        onOk={handleUpdate}
        onCancel={() => {
          form.resetFields();
          setEditModalOpen(false);
          setEditingArtifact(null);
        }}
        okText="Save"
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            label="Name"
            name="name"
            rules={[{ required: true, message: 'Please enter a name' }]}
          >
            <Input placeholder="My Artifact" />
          </Form.Item>
          <Form.Item label="Description" name="description">
            <Input.TextArea rows={3} placeholder="Optional description" />
          </Form.Item>
          <Form.Item
            label="Board"
            name="board_id"
            tooltip="Move this artifact to a different board. Its position on the board is preserved."
            rules={[{ required: true, message: 'Please select a board' }]}
          >
            <Select
              showSearch
              placeholder="Select board..."
              options={boardOptions}
              filterOption={(input, option) =>
                (option?.label?.toString() ?? '').toLowerCase().includes(input.toLowerCase())
              }
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};
