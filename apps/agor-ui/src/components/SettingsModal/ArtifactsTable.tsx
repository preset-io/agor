import type { Artifact, ArtifactID, Board, Branch } from '@agor-live/client';
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
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { mapToArray, mapToSortedArray } from '@/utils/mapHelpers';
import { filterBySettingsSearch } from '@/utils/settingsSearch';
import { uiRouteHref } from '@/utils/uiRoutes';
import { useAppNavigation } from '../../hooks/useAppNavigation';
import { ArchiveToggleButton } from '../ArchiveButton';
import { boardSelectOptions, getBoardEmoji } from '../BoardTile';
import { HighlightMatch } from '../HighlightMatch';
import { ListPanelHeader } from './panelPrimitives';
import { SettingsActionGroup } from './SettingsActionGroup';
import { DrillInFrame, useSettingsDrill } from './SettingsDrill';

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
  onUpdate,
  onDelete,
  onClose,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [archivedFilter, setArchivedFilter] = useState<'active' | 'archived' | 'all'>('active');
  const [dirty, setDirty] = useState(false);
  const [form] = Form.useForm();
  const { token } = theme.useToken();
  const { drill, openDrill, closeDrill } = useSettingsDrill();

  // Editing swaps this section's Content pane for the drill-in editor below,
  // instead of stacking a second Modal on top of Settings.
  const editingArtifact =
    drill?.kind === 'artifacts' && drill.recordId
      ? (artifactById.get(drill.recordId) ?? null)
      : null;

  const openEdit = useCallback(
    (artifact: Artifact) =>
      openDrill({ kind: 'artifacts', mode: 'edit', recordId: artifact.artifact_id }),
    [openDrill]
  );

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

  // Seed the form whenever the drill-in targets a new artifact.
  useEffect(() => {
    if (editingArtifact) {
      form.setFieldsValue({
        name: editingArtifact.name,
        description: editingArtifact.description || '',
        board_id: editingArtifact.board_id,
      });
      setDirty(false);
    }
  }, [editingArtifact, form]);

  const handleUpdate = useCallback(async () => {
    if (!editingArtifact) return;
    const values = await form.validateFields();
    // Build a patch of only fields that actually changed. If nothing changed,
    // skip the network round-trip — avoids a spurious `patched` broadcast.
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
    setDirty(false);
    closeDrill();
  }, [closeDrill, editingArtifact, form, onUpdate]);

  const boardOptions = boardSelectOptions(mapToArray(boardById), branchById);

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
            <Typography.Link
              ellipsis
              title={displayName}
              style={artifactTextStyle}
              onClick={() => openEdit(artifact)}
            >
              <HighlightMatch text={displayName} query={searchTerm} />
            </Typography.Link>
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
        const boardEmoji = board ? getBoardEmoji(board, branchById) : undefined;
        const boardText = board
          ? `${boardEmoji ? `${boardEmoji} ` : ''}${board.name}`
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
              onClick={() => openEdit(artifact)}
            />
          </Tooltip>
          <ArchiveToggleButton
            archived={Boolean(artifact.archived)}
            tooltip={artifact.archived ? 'Archived • Click to unarchive' : 'Archive artifact'}
            onToggle={(nextArchived) =>
              onUpdate?.(artifact.artifact_id, { archived: nextArchived })
            }
          />
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

  const visibleArtifacts = useMemo(() => {
    const sorted = mapToSortedArray(artifactById, (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );
    if (archivedFilter === 'active') return sorted.filter((artifact) => !artifact.archived);
    if (archivedFilter === 'archived') return sorted.filter((artifact) => artifact.archived);
    return sorted;
  }, [artifactById, archivedFilter]);

  const dataSource = useMemo(
    () =>
      filterBySettingsSearch(visibleArtifacts, searchTerm, [
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
      ]),
    [visibleArtifacts, searchTerm, branchById, boardById]
  );

  if (editingArtifact) {
    return (
      <DrillInFrame
        title={`Edit ${editingArtifact.name || shortId(editingArtifact.artifact_id)}`}
        dirty={dirty}
        onSave={handleUpdate}
      >
        <Form
          form={form}
          layout="vertical"
          style={{ maxWidth: 520 }}
          onValuesChange={() => setDirty(true)}
        >
          {/* Read-only orientation: which template this artifact runs and which
              branch produced it — neither is editable here. */}
          <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
            Template{' '}
            <Tag color={templateColors[editingArtifact.template] ?? 'default'}>
              {editingArtifact.template}
            </Tag>
            {editingArtifact.branch_id && (
              <>
                {' · '}Branch{' '}
                <Typography.Text code>
                  {branchById.get(editingArtifact.branch_id)?.name ??
                    shortId(editingArtifact.branch_id)}
                </Typography.Text>
              </>
            )}
          </Typography.Paragraph>
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
      </DrillInFrame>
    );
  }

  return (
    <div>
      <ListPanelHeader
        title="Artifacts"
        description="Live web application artifacts created by agents via MCP tools."
        search={
          <Space>
            <Input
              allowClear
              placeholder="Search name, description, template, branch, or board"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              style={{ width: 360 }}
            />
            <Select
              value={archivedFilter}
              onChange={setArchivedFilter}
              style={{ width: 130 }}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'archived', label: 'Archived' },
                { value: 'all', label: 'All' },
              ]}
            />
          </Space>
        }
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
          {visibleArtifacts.length === 0 ? (
            <Empty
              description={
                archivedFilter === 'archived' ? 'No archived artifacts' : 'No artifacts yet'
              }
            >
              {archivedFilter !== 'archived' && (
                <Typography.Text type="secondary">
                  Artifacts are created by agents using the <code>agor_artifacts_publish</code> MCP
                  tool.
                </Typography.Text>
              )}
            </Empty>
          ) : (
            <Empty description={`No artifacts match “${searchTerm}”`} />
          )}
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
    </div>
  );
};
