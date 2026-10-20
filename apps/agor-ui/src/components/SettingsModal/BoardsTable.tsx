import {
  type AgorClient,
  type Board,
  type Branch,
  hasMinimumRole,
  ROLES,
  summarizeBoardImportSkips,
  type User,
} from '@agor-live/client';
import {
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  PlusOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { App, Button, Form, Input, Popconfirm, Select, Tooltip, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { formatActionError, notConnectedMessage } from '@/utils/connectionErrors';
import { mapToSortedArray } from '@/utils/mapHelpers';
import { useThemedMessage } from '@/utils/message';
import { filterBySettingsSearch } from '@/utils/settingsSearch';
import { ArchiveToggleButton } from '../ArchiveButton';
import { BoardEditModal } from '../BoardEditModal';
import { BoardTile, getBoardEmoji } from '../BoardTile';
import { BoardFormFields, extractBoardFormValues } from '../forms/BoardFormFields';
import { HighlightMatch } from '../HighlightMatch';
import { JSONEditor, validateJSON } from '../JSONEditor';
import { ResponsiveSettingsHeader } from './ResponsiveSettingsHeader';
import { ResponsiveTable } from './ResponsiveTable';
import { SettingsActionGroup } from './SettingsActionGroup';
import { DrillInFrame, useDrillFormDraft, useSettingsDrill } from './SettingsDrill';
import { useSessionCounts } from './useBranchPage';

interface BoardsTableProps {
  client: AgorClient | null;
  boardById: Map<string, Board>;
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
  branchById,
  currentUser,
  onCreate,
  onUpdate,
  onDelete,
  onArchive,
  onUnarchive,
}) => {
  const { modal } = App.useApp();
  const { showSuccess, showError, showWarning } = useThemedMessage();
  // Creating, importing, cloning and changing boards need member or above
  // (the daemon enforces it); viewers see these actions disabled.
  const canManageBoards = hasMinimumRole(currentUser?.role, ROLES.MEMBER);
  // Create board is a drill-in (no stacked modal on top of Settings).
  const { drill, openDrill, closeDrill } = useSettingsDrill();
  // Edit board also drills in place of the list (no stacked modal), driven by
  // the shell drill state so the breadcrumb + leave-guards apply.
  const editingBoard =
    drill?.mode === 'edit' && drill.recordId ? (boardById.get(drill.recordId) ?? null) : null;
  const [archiveFilter, setArchiveFilter] = useState<'active' | 'archived' | 'all'>('active');
  const [searchTerm, setSearchTerm] = useState('');
  const [form] = Form.useForm();

  const isCreating = drill?.mode === 'create';
  // New boards start on the theme-aware default (no persisted background); the
  // editor's Default mode reflects a fresh form.
  useEffect(() => {
    if (isCreating) {
      form.resetFields();
    }
  }, [isCreating, form]);
  const isCreateDirty = useDrillFormDraft(form, isCreating ? drill : null);

  const handleCreate = () => {
    // Validate all fields (not just 'name') so custom_context JSON rules run.
    // Otherwise the extractor's JSON.parse can throw and get swallowed.
    form
      .validateFields()
      .then(() => {
        onCreate?.(extractBoardFormValues(form));
        form.resetFields();
        closeDrill();
      })
      .catch(() => {
        // Antd displays inline field errors; nothing to do here.
      });
  };

  const handleEdit = (board: Board) => openDrill({ mode: 'edit', recordId: board.board_id });

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
          const message = notConnectedMessage('clone the board');
          showError(message);
          return Promise.reject(new Error(message));
        }

        const boardsService = client.service('boards');
        return boardsService
          .clone({ id: board.board_id, name: newName })
          .then((clonedBoard) => {
            showSuccess(`Board cloned as ${clonedBoard.name}.`);
            onCreate?.(clonedBoard);
          })
          .catch((error) => {
            showError(formatActionError('clone the board', error, { idempotent: false }));
            return Promise.reject(error);
          });
      },
    });
  };

  const handleExport = async (board: Board) => {
    if (!client) {
      showError(notConnectedMessage('export the board'));
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

      showSuccess('Board exported.');
    } catch (error) {
      showError(formatActionError('export the board', error, { idempotent: true }));
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
      showError(notConnectedMessage('import the board'));
      return;
    }

    const content = await file.text();
    const isJson = file.name.endsWith('.json');
    let blob: unknown;
    if (isJson) {
      try {
        blob = JSON.parse(content);
      } catch {
        showError("Couldn't import the board. The file isn't valid JSON.");
        return;
      }
    }

    try {
      const boardsService = client.service('boards');
      const board = isJson
        ? await boardsService.fromBlob(blob as Parameters<typeof boardsService.fromBlob>[0])
        : await boardsService.fromYaml({ yaml: content });

      const skippedSummary = summarizeBoardImportSkips(board.import_skipped);
      if (skippedSummary) {
        // Persistent so the skipped list stays readable.
        showWarning(`Imported ${board.name}, but not everything came across: ${skippedSummary}`, {
          duration: 0,
        });
      } else {
        showSuccess(`Board imported as ${board.name}.`);
      }
      onCreate?.(board);
    } catch (error) {
      showError(formatActionError('import the board', error, { idempotent: false }));
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
  const boardSessionCounts = useSessionCounts(client, 'board_id');

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
      render: (_: unknown, board: Board) => boardSessionCounts.get(board.board_id) ?? null,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 184,
      render: (_: unknown, board: Board) => (
        <SettingsActionGroup>
          <ArchiveToggleButton
            disabled={!canManageBoards}
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
              disabled={!canManageBoards}
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
              disabled={!canManageBoards}
              onClick={() => handleEdit(board)}
            />
          </Tooltip>
          <Popconfirm
            // Anchored to the icon's right edge (the column sits at the dialog's
            // right), and wrapped like other delete confirms, so it never runs
            // into the viewport edge.
            placement="topRight"
            overlayStyle={{ maxWidth: 500 }}
            title="Delete board?"
            description={`Are you sure you want to delete "${board.name}"? Sessions will not be deleted.`}
            onConfirm={() => handleDelete(board.board_id)}
            okText="Delete"
            cancelText="Cancel"
            okButtonProps={{ danger: true }}
            disabled={!canManageBoards}
          >
            <Tooltip title="Delete board (sessions will not be deleted)">
              <Button
                type="text"
                size="small"
                icon={<DeleteOutlined />}
                danger
                disabled={!canManageBoards}
              />
            </Tooltip>
          </Popconfirm>
        </SettingsActionGroup>
      ),
    },
  ];

  // Create board drills in place of the list (no stacked modal). Early-returned
  // so the Content pane swaps list↔editor; the shell footer renders
  // Create/Cancel and the breadcrumb ("Boards ›") backs out via closeDrill.
  if (isCreating) {
    return (
      <DrillInFrame
        title="Create Board"
        saveLabel="Create"
        dirty={isCreateDirty}
        onSave={handleCreate}
        onBack={() => {
          form.resetFields();
          closeDrill();
        }}
      >
        <Form form={form} layout="vertical" preserve style={{ maxWidth: 520 }}>
          <BoardFormFields form={form} extra={customContextField} />
        </Form>
      </DrillInFrame>
    );
  }

  // Edit board drills in place of the list (BoardEditModal in embedded mode).
  if (editingBoard) {
    return (
      <BoardEditModal
        embedded
        board={editingBoard}
        client={client}
        open
        onClose={closeDrill}
        onUpdate={onUpdate}
        currentUser={currentUser}
      />
    );
  }

  return (
    <div>
      <ResponsiveSettingsHeader
        title="Boards"
        description="Create and manage boards for organizing sessions."
        search={
          <Input
            allowClear
            placeholder="Search name, slug, description, or ID"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />
        }
        filters={
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
        }
        count={`${boards.length} ${boards.length === 1 ? 'board' : 'boards'}`}
        primaryActions={
          <>
            <Button
              icon={<UploadOutlined />}
              disabled={!canManageBoards}
              onClick={handleImportClick}
            >
              Import Board
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={!canManageBoards}
              onClick={() => openDrill({ mode: 'create' })}
            >
              New Board
            </Button>
          </>
        }
      />

      <ResponsiveTable
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
    </div>
  );
};
