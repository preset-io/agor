import type { Artifact, ArtifactID, Board, Branch } from '@agor-live/client';
import { artifactFullscreenPath, shortId } from '@agor-live/client';
import { AimOutlined, DeleteOutlined, EditOutlined, ExportOutlined } from '@ant-design/icons';
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
  theme,
} from 'antd';
import type { CSSProperties } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { mapToArray, mapToSortedArray } from '@/utils/mapHelpers';
import { filterBySettingsSearch } from '@/utils/settingsSearch';
import { uiRouteHref } from '@/utils/uiRoutes';
import { useAppNavigation } from '../../hooks/useAppNavigation';
import { HighlightMatch } from '../HighlightMatch';
import { SettingsActionGroup } from './SettingsActionGroup';

interface ArtifactsTableProps {
  artifactById: Map<string, Artifact>;
  branchById: Map<string, Branch>;
  boardById: Map<string, Board>;
  onUpdate?: (artifactId: string, updates: Partial<Artifact>) => void;
  onDelete?: (artifactId: string) => void;
  /** Close the parent Settings modal so the canvas isn't obscured by it
   *  after recenter. Wired by SettingsModal. */
  onClose?: () => void;
}

const templateColors: Record<string, string> = {
  react: 'cyan',
  'react-ts': 'blue',
  vanilla: 'green',
  'vanilla-ts': 'geekblue',
};

const artifactTextStyle: CSSProperties = {
  display: 'block',
  maxWidth: '100%',
};

export const ArtifactsTable: React.FC<ArtifactsTableProps> = ({
  artifactById,
  branchById,
  boardById,
  onUpdate,
  onDelete,
  onClose,
}) => {
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingArtifact, setEditingArtifact] = useState<Artifact | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [form] = Form.useForm();
  const { token } = theme.useToken();

  // Reuses the `artifactById` prop so we don't read the same data via
  // both props and context. Only goToArtifact is used from this table.
  const navigation = useAppNavigation({ boardById, artifactById });

  const handleRecenter = useCallback(
    (artifact: Artifact) => {
      // Close the modal first so the canvas isn't obscured by it after the
      // pan/zoom. goToArtifact pushes the shareable URL and recenterMap
      // handles the cross-board case via the queue+switch mechanism.
      onClose?.();
      navigation.goToArtifact(artifact.artifact_id);
    },
    [onClose, navigation]
  );

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
      width: '38%',
      render: (name: string, artifact: Artifact) => {
        const displayName = name || shortId(artifact.artifact_id);
        return (
          <Space orientation="vertical" size={0} style={{ width: '100%' }}>
            <Typography.Text strong ellipsis={{ tooltip: displayName }} style={artifactTextStyle}>
              <HighlightMatch text={displayName} query={searchTerm} />
            </Typography.Text>
            {artifact.description && (
              <Typography.Text
                type="secondary"
                ellipsis={{ tooltip: artifact.description }}
                style={{ ...artifactTextStyle, fontSize: token.fontSizeSM }}
              >
                <HighlightMatch text={artifact.description} query={searchTerm} />
              </Typography.Text>
            )}
            <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              Created {new Date(artifact.created_at).toLocaleDateString()}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: 'Status',
      key: 'status',
      width: 150,
      render: (_: unknown, artifact: Artifact) => {
        const map: Record<
          string,
          { status: 'success' | 'error' | 'processing' | 'default'; text: string }
        > = {
          success: { status: 'success', text: 'Success' },
          error: { status: 'error', text: 'Error' },
          checking: { status: 'processing', text: 'Checking' },
          unknown: { status: 'default', text: 'Unknown' },
        };
        const info = map[artifact.build_status] || map.unknown;
        return (
          <Space orientation="vertical" size={0}>
            <Badge status={info.status} text={info.text} />
            <Tag
              color={templateColors[artifact.template] || 'default'}
              style={{ marginInlineEnd: 0 }}
            >
              <HighlightMatch text={artifact.template} query={searchTerm} />
            </Tag>
          </Space>
        );
      },
    },
    {
      title: 'Location',
      key: 'location',
      width: '32%',
      render: (_: unknown, artifact: Artifact) => {
        const branch = artifact.branch_id ? branchById.get(artifact.branch_id) : undefined;
        const branchText = artifact.branch_id ? branch?.name || shortId(artifact.branch_id) : '—';
        const board = boardById.get(artifact.board_id);
        const boardText = board
          ? `${board.icon || ''} ${board.name}`.trim()
          : shortId(artifact.board_id);
        return (
          <Space orientation="vertical" size={0} style={{ width: '100%' }}>
            <Typography.Text
              type="secondary"
              ellipsis={{ tooltip: `Board: ${boardText}` }}
              style={artifactTextStyle}
            >
              Board: <HighlightMatch text={boardText} query={searchTerm} />
            </Typography.Text>
            <Typography.Text
              type="secondary"
              ellipsis={{ tooltip: `Branch: ${branchText}` }}
              style={artifactTextStyle}
            >
              Branch: <HighlightMatch text={branchText} query={searchTerm} />
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 124,
      render: (_: unknown, artifact: Artifact) => (
        <SettingsActionGroup>
          {artifact.board_id && (
            <Tooltip title="Center map on artifact">
              <Button
                type="text"
                size="small"
                icon={<AimOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  handleRecenter(artifact);
                }}
              />
            </Tooltip>
          )}
          <Tooltip title="Open fullscreen">
            <Button
              type="text"
              size="small"
              icon={<ExportOutlined />}
              href={uiRouteHref(artifactFullscreenPath(artifact.artifact_id as ArtifactID))}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
            />
          </Tooltip>
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
        </SettingsActionGroup>
      ),
    },
  ];

  const dataSource = useMemo(() => {
    const activeArtifacts = mapToSortedArray(artifactById, (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    ).filter((artifact) => !artifact.archived);
    return filterBySettingsSearch(activeArtifacts, searchTerm, [
      (artifact) => artifact.name,
      (artifact) => artifact.description,
      (artifact) => artifact.template,
      (artifact) => artifact.build_status,
      (artifact) => artifact.artifact_id,
      (artifact) => {
        const branch = artifact.branch_id ? branchById.get(artifact.branch_id) : undefined;
        return [branch?.name, branch?.ref, artifact.branch_id];
      },
      (artifact) => {
        const board = boardById.get(artifact.board_id);
        return [board?.name, board?.slug, artifact.board_id];
      },
    ]);
  }, [artifactById, searchTerm, branchById, boardById]);

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
          Live web application artifacts created by agents via MCP tools.
        </Typography.Text>
        <Input
          allowClear
          placeholder="Search name, description, template, branch, or board"
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
          style={{ width: 360 }}
        />
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
          tableLayout="fixed"
          scroll={{ x: 760 }}
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
