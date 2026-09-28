import type { Artifact, ArtifactID, Board, Branch, User } from '@agor-live/client';
import { artifactFullscreenPath, shortId } from '@agor-live/client';
import { AimOutlined, DeleteOutlined, EditOutlined, ExportOutlined } from '@ant-design/icons';
import {
  Badge,
  Button,
  Empty,
  Form,
  Input,
  Popconfirm,
  Select,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { CSSProperties } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { mapToArray, mapToSortedArray } from '@/utils/mapHelpers';
import { filterBySettingsSearch } from '@/utils/settingsSearch';
import { uiRouteHref } from '@/utils/uiRoutes';
import { useAppNavigation } from '../../hooks/useAppNavigation';
import { boardSelectFilter, boardSelectOptions, getBoardEmoji } from '../BoardTile';
import { HighlightMatch } from '../HighlightMatch';
import { AdaptiveSettingsModal } from './AdaptiveSettingsModal';
import { ResponsiveSettingsHeader } from './ResponsiveSettingsHeader';
import { ResponsiveTable } from './ResponsiveTable';
import { SettingsActionGroup } from './SettingsActionGroup';
import { SettingsIdentity } from './SettingsIdentity';

interface ArtifactsTableProps {
  artifactById: Map<string, Artifact>;
  branchById: Map<string, Branch>;
  boardById: Map<string, Board>;
  userById: Map<string, User>;
  onUpdate?: (artifactId: string, updates: Partial<Artifact>) => void;
  onDelete?: (artifactId: string) => void;
  /** Close the parent Settings modal so the canvas isn't obscured by it
   *  after recenter. Wired by SettingsModal. */
  onClose?: () => void;
}

const templateColors: Record<string, string> = {
  static: 'default',
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
  userById,
  onUpdate,
  onDelete,
  onClose,
}) => {
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingArtifact, setEditingArtifact] = useState<Artifact | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [form] = Form.useForm();

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
      setEditModalOpen(false);
    });
  };

  const boardOptions = boardSelectOptions(mapToArray(boardById), branchById);

  const columns = [
    {
      title: 'Artifact',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, artifact: Artifact) => (
        <SettingsIdentity
          name={name || shortId(artifact.artifact_id)}
          query={searchTerm}
          description={artifact.description}
          metadata={
            <Tag color={templateColors[artifact.template] || 'default'}>
              <HighlightMatch text={artifact.template} query={searchTerm} />
            </Tag>
          }
        />
      ),
    },
    {
      title: 'Board',
      key: 'board',
      width: 140,
      render: (_: unknown, artifact: Artifact) => {
        const board = boardById.get(artifact.board_id);
        const emoji = board ? getBoardEmoji(board, branchById) : undefined;
        const label = board ? `${emoji ? `${emoji} ` : ''}${board.name}` : 'Unavailable board';
        return (
          <Typography.Text ellipsis={{ tooltip: label }} style={artifactTextStyle}>
            <HighlightMatch text={label} query={searchTerm} />
          </Typography.Text>
        );
      },
    },
    {
      title: 'Owner',
      key: 'owner',
      width: 140,
      render: (_: unknown, artifact: Artifact) => {
        // The artifact service authorizes its creator as owner. Resolve only
        // from the existing authorized directory; never fetch identities per row.
        const user = artifact.created_by ? userById.get(artifact.created_by) : undefined;
        const label =
          user?.name || user?.email || (artifact.created_by ? 'Unavailable user' : 'Not recorded');
        return (
          <Typography.Text ellipsis={{ tooltip: label }} style={artifactTextStyle}>
            <HighlightMatch text={label} query={searchTerm} />
          </Typography.Text>
        );
      },
    },
    {
      title: 'Build',
      key: 'status',
      width: 100,
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
        return <Badge status={info.status} text={info.text} />;
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 124,
      fixed: 'right' as const,
      render: (_: unknown, artifact: Artifact) => (
        <SettingsActionGroup>
          {artifact.board_id && (
            <Tooltip title="Center map on artifact">
              <Button
                type="text"
                size="small"
                aria-label="Center map on artifact"
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
              aria-label="Open fullscreen"
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
              aria-label="Edit artifact"
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
              <Button
                aria-label="Delete artifact"
                type="text"
                size="small"
                icon={<DeleteOutlined />}
                danger
              />
            </Tooltip>
          </Popconfirm>
        </SettingsActionGroup>
      ),
    },
  ];

  const dataSource = useMemo(() => {
    const activeArtifacts = mapToSortedArray(
      artifactById,
      (a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
        a.artifact_id.localeCompare(b.artifact_id)
    ).filter((artifact) => !artifact.archived);
    return filterBySettingsSearch(activeArtifacts, searchTerm, [
      (artifact) => artifact.name,
      (artifact) => artifact.description,
      (artifact) => artifact.template,
      (artifact) => artifact.build_status,
      (artifact) => artifact.artifact_id,
      (artifact) => {
        const user = artifact.created_by ? userById.get(artifact.created_by) : undefined;
        return [user?.name, user?.email];
      },
      (artifact) => {
        const branch = artifact.branch_id ? branchById.get(artifact.branch_id) : undefined;
        return [branch?.name, branch?.ref, artifact.branch_id];
      },
      (artifact) => {
        const board = boardById.get(artifact.board_id);
        return [board?.name, board?.slug, artifact.board_id];
      },
    ]);
  }, [artifactById, searchTerm, branchById, boardById, userById]);

  return (
    <div>
      <ResponsiveSettingsHeader
        description="Live web application artifacts created by agents via MCP tools."
        actions={(compact) => (
          <Input
            allowClear
            placeholder="Search name, description, template, branch, board, or owner"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            style={{ width: compact ? '100%' : 360, maxWidth: '100%' }}
          />
        )}
      />

      {dataSource.length === 0 ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 400,
          }}
        >
          <Empty description={searchTerm ? 'No matching artifacts' : 'No artifacts yet'}>
            <Typography.Text type="secondary">
              Artifacts are created by agents using the <code>agor_artifacts_publish</code> MCP
              tool.
            </Typography.Text>
          </Empty>
        </div>
      ) : (
        <ResponsiveTable
          key={searchTerm}
          primaryColumnKey="name"
          dataSource={dataSource}
          columns={columns}
          rowKey="artifact_id"
          pagination={false}
          size="small"
          tableLayout="fixed"
          scroll={{ x: 700 }}
        />
      )}

      {editingArtifact && (
        <AdaptiveSettingsModal
          title="Edit Artifact"
          open={editModalOpen}
          onOk={handleUpdate}
          onCancel={() => {
            setEditModalOpen(false);
          }}
          afterClose={() => {
            form.resetFields();
            setEditingArtifact(null);
          }}
          okText="Save"
        >
          <Typography.Paragraph type="secondary">
            Created {new Date(editingArtifact.created_at).toLocaleString()}
            <br />
            Source branch:{' '}
            {editingArtifact.branch_id
              ? branchById.get(editingArtifact.branch_id)?.name || 'Unavailable branch'
              : 'Not recorded'}
          </Typography.Paragraph>
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
                filterOption={boardSelectFilter}
              />
            </Form.Item>
          </Form>
        </AdaptiveSettingsModal>
      )}
    </div>
  );
};
