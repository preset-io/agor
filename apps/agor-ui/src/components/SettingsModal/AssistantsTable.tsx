import type {
  AgorClient,
  Board,
  CreateRepoRequest,
  Repo,
  Session,
  User,
  Worktree,
} from '@agor-live/client';
import { getAssistantConfig, isAssistant } from '@agor-live/client';
import {
  AimOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import {
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Popover,
  Space,
  Table,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { useCallback, useMemo, useState } from 'react';
import { useAssistantForm } from '@/hooks/useAssistantForm';
import { useEnsureFrameworkRepo } from '@/hooks/useEnsureFrameworkRepo';
import { createAssistantWorktree } from '@/utils/assistantCreation';
import { mapToArray } from '@/utils/mapHelpers';
import { useAppNavigation } from '../../hooks/useAppNavigation';
import { ArchiveDeleteWorktreeModal } from '../ArchiveDeleteWorktreeModal';
import { AssistantFormFields, CREATE_NEW_BOARD } from '../forms/AssistantFormFields';
import { MarkdownRenderer } from '../MarkdownRenderer/MarkdownRenderer';
import { UserAvatar } from '../metadata/UserAvatar';
import type { WorktreeUpdate } from '../WorktreeModal/tabs/GeneralTab';

interface AssistantsTableProps {
  worktreeById: Map<string, Worktree>;
  repoById: Map<string, Repo>;
  boardById: Map<string, Board>;
  sessionsByWorktree: Map<string, Session[]>;
  userById: Map<string, User>;
  client: AgorClient | null;
  onArchiveOrDelete?: (
    worktreeId: string,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    }
  ) => void;
  onRowClick?: (worktree: Worktree) => void;
  onCreateWorktree?: (
    repoId: string,
    data: {
      name: string;
      ref: string;
      createBranch: boolean;
      sourceBranch: string;
      pullLatest: boolean;
      boardId?: string;
    }
  ) => Promise<Worktree | null>;
  onUpdateWorktree?: (worktreeId: string, updates: WorktreeUpdate) => void;
  onCreateRepo?: (data: CreateRepoRequest) => void | Promise<void>;
  /** Close the parent Settings modal so the canvas isn't obscured by
   *  it after recenter. Wired by SettingsModal. */
  onClose?: () => void;
}

export const AssistantsTable: React.FC<AssistantsTableProps> = ({
  worktreeById,
  repoById,
  boardById,
  sessionsByWorktree,
  userById,
  client,
  onArchiveOrDelete,
  onRowClick,
  onCreateWorktree,
  onUpdateWorktree,
  onCreateRepo,
  onClose,
}) => {
  const repos = mapToArray(repoById);
  const boards = mapToArray(boardById);

  // Assistants ARE worktrees (just worktrees flagged via
  // `custom_context.assistant`), so navigation reuses the `/w/<short>/`
  // URL via `goToWorktree` — no separate `/assistant/<short>/` route.
  // Reuses the `worktreeById` prop directly so we don't read the same
  // data twice (props + context).
  const navigation = useAppNavigation({ boardById, worktreeById });

  const handleRecenter = useCallback(
    (assistant: Worktree) => {
      // Close the modal first so the canvas isn't obscured. goToWorktree
      // pushes `/w/<short>/`; the URL→state effect handles cross-board
      // switching + recenter.
      onClose?.();
      navigation.goToWorktree(assistant.worktree_id);
    },
    [onClose, navigation]
  );
  const { token } = theme.useToken();

  const [createModalOpen, setCreateModalOpen] = useState(false);

  // Only auto-clone the framework repo when the create modal is open,
  // so merely visiting the Assistants settings tab doesn't trigger a clone.
  const { frameworkRepo, isCloning } = useEnsureFrameworkRepo(repos, onCreateRepo, {
    enabled: createModalOpen,
  });
  const {
    form,
    isFormValid,
    customRepoSelected,
    setCustomRepoSelected,
    validateForm,
    handleDisplayNameChange,
    resetForm,
  } = useAssistantForm(frameworkRepo);
  const [creating, setCreating] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const [archiveDeleteModalOpen, setArchiveDeleteModalOpen] = useState(false);
  const [selectedWorktree, setSelectedWorktree] = useState<Worktree | null>(null);

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      setCreating(true);

      const repoId = values.repoId || frameworkRepo?.repo_id;
      if (!repoId) {
        form.setFields([
          {
            name: 'repoId',
            errors: [
              'Framework repository is still being registered. Please wait a moment and try again.',
            ],
          },
        ]);
        return;
      }

      if (!onCreateWorktree || !onUpdateWorktree) return;

      await createAssistantWorktree(
        {
          displayName: values.displayName.trim(),
          description: values.description || undefined,
          emoji: values.emoji || undefined,
          boardChoice: values.boardChoice,
          repoId,
          worktreeName: values.name || undefined,
          sourceBranch: values.sourceBranch || undefined,
        },
        { client, repoById, onCreateWorktree, onUpdateWorktree }
      );

      setCreateModalOpen(false);
      resetForm();
    } catch (error) {
      console.error('Assistant creation failed:', error);
    } finally {
      setCreating(false);
    }
  };

  const handleCancel = () => {
    setCreateModalOpen(false);
    resetForm();
  };

  const assistants = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    const assistantWorktrees = Array.from(worktreeById.values())
      .filter((w) => !w.archived && isAssistant(w))
      .sort((a, b) => {
        const nameA = getAssistantConfig(a)?.displayName ?? a.name;
        const nameB = getAssistantConfig(b)?.displayName ?? b.name;
        return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
      });

    if (!term) return assistantWorktrees;

    return assistantWorktrees.filter((w) => {
      const config = getAssistantConfig(w);
      const repo = repoById.get(w.repo_id);
      const creator = userById.get(w.created_by);
      const haystacks = [
        config?.displayName,
        w.name,
        w.notes,
        creator?.name,
        creator?.email,
        repo?.name,
        repo?.slug,
      ];
      return haystacks.some((v) => v?.toLowerCase().includes(term));
    });
  }, [worktreeById, repoById, userById, searchTerm]);

  const columns = [
    {
      title: 'Assistant',
      key: 'assistant',
      width: 220,
      render: (_: unknown, record: Worktree) => {
        const config = getAssistantConfig(record);
        return (
          <Space>
            {config?.emoji ? (
              <span style={{ fontSize: 18 }}>{config.emoji}</span>
            ) : (
              <RobotOutlined style={{ color: token.colorInfo }} />
            )}
            <Typography.Text strong>{config?.displayName ?? record.name}</Typography.Text>
          </Space>
        );
      },
    },
    {
      title: 'Description',
      key: 'description',
      render: (_: unknown, record: Worktree) => {
        const notes = (record.notes ?? '').trim();
        if (!notes) {
          return (
            <Typography.Text type="secondary" italic style={{ fontSize: 12 }}>
              No description
            </Typography.Text>
          );
        }
        const firstLine = notes.split('\n').find((l) => l.trim().length > 0) ?? notes;
        // Cell shows plain first-line ellipsis; popover renders full markdown.
        // MarkdownRenderer's `inline` is currently a no-op (Streamdown still
        // emits block nodes), so plain text is the honest preview here.
        return (
          <Popover
            content={
              <div
                className="markdown-compact"
                style={{
                  maxWidth: 480,
                  maxHeight: 400,
                  overflowY: 'auto',
                  fontSize: 12,
                  lineHeight: 1.5,
                }}
              >
                <MarkdownRenderer content={notes} showControls={false} />
              </div>
            }
            trigger="hover"
            placement="topLeft"
            mouseEnterDelay={0.3}
          >
            <Typography.Text
              type="secondary"
              ellipsis
              style={{
                display: 'block',
                maxWidth: 480,
                fontSize: 12,
                cursor: 'help',
              }}
            >
              {firstLine}
            </Typography.Text>
          </Popover>
        );
      },
    },
    {
      title: 'Creator',
      key: 'creator',
      width: 160,
      render: (_: unknown, record: Worktree) => {
        const user = userById.get(record.created_by);
        if (!user || record.created_by === 'anonymous') {
          return (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {record.created_by === 'anonymous' ? 'Anonymous' : 'Unknown User'}
            </Typography.Text>
          );
        }
        return <UserAvatar user={user} showName size="small" />;
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 130,
      render: (_: unknown, record: Worktree) => (
        <Space size="small">
          {record.board_id && (
            <Tooltip title="Center map on assistant">
              <Button
                type="text"
                size="small"
                icon={<AimOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  handleRecenter(record);
                }}
              />
            </Tooltip>
          )}
          <Tooltip title="Edit assistant">
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                onRowClick?.(record);
              }}
            />
          </Tooltip>
          <Tooltip title="Delete assistant">
            <Button
              type="text"
              size="small"
              icon={<DeleteOutlined />}
              danger
              onClick={(e) => {
                e.stopPropagation();
                setSelectedWorktree(record);
                setArchiveDeleteModalOpen(true);
              }}
            />
          </Tooltip>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space
        orientation="vertical"
        size={token.sizeUnit * 2}
        style={{ marginBottom: token.sizeUnit * 2, width: '100%' }}
      >
        <Typography.Text type="secondary">
          Assistants are persistent AI companions backed by a framework repo. They maintain memory,
          orchestrate work across worktrees, and run on scheduled heartbeats.
        </Typography.Text>
        <Space style={{ width: '100%', display: 'flex', justifyContent: 'space-between' }}>
          <Input
            allowClear
            placeholder="Search assistants..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{ maxWidth: token.sizeUnit * 40 }}
          />
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setCreateModalOpen(true)}
            disabled={!frameworkRepo && repos.length === 0}
          >
            Create Assistant
          </Button>
        </Space>
      </Space>

      {assistants.length === 0 && !searchTerm && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 300,
          }}
        >
          <Empty
            image={<RobotOutlined style={{ fontSize: 48, color: token.colorTextDisabled }} />}
            description="No assistants yet"
          >
            <Typography.Text type="secondary">
              Create an assistant to get started, or use the onboarding wizard.
            </Typography.Text>
          </Empty>
        </div>
      )}

      {(assistants.length > 0 || searchTerm) && (
        <Table
          dataSource={assistants}
          columns={columns}
          rowKey="worktree_id"
          pagination={{ pageSize: 10 }}
          size="small"
          onRow={(record) => ({
            onClick: () => onRowClick?.(record),
            style: { cursor: onRowClick ? 'pointer' : 'default' },
          })}
        />
      )}

      {/* Create Assistant Modal */}
      <Modal
        title="Create Assistant"
        open={createModalOpen}
        onOk={handleCreate}
        onCancel={handleCancel}
        okText="Create"
        okButtonProps={{ disabled: !isFormValid, loading: creating }}
      >
        <Form
          form={form}
          layout="vertical"
          onFieldsChange={validateForm}
          initialValues={{ boardChoice: CREATE_NEW_BOARD, sourceBranch: 'main' }}
        >
          <AssistantFormFields
            form={form}
            repos={repos}
            boards={boards}
            frameworkRepo={frameworkRepo}
            isCloning={isCloning}
            onDisplayNameChange={handleDisplayNameChange}
            customRepoSelected={customRepoSelected}
            onCustomRepoChange={setCustomRepoSelected}
          />
        </Form>
      </Modal>

      {/* Archive/Delete Modal */}
      {selectedWorktree && (
        <ArchiveDeleteWorktreeModal
          open={archiveDeleteModalOpen}
          worktree={selectedWorktree}
          sessionCount={(sessionsByWorktree.get(selectedWorktree.worktree_id) || []).length}
          environmentRunning={selectedWorktree.environment_instance?.status === 'running'}
          onConfirm={(options) => {
            onArchiveOrDelete?.(selectedWorktree.worktree_id, options);
            setArchiveDeleteModalOpen(false);
            setSelectedWorktree(null);
          }}
          onCancel={() => {
            setArchiveDeleteModalOpen(false);
            setSelectedWorktree(null);
          }}
        />
      )}
    </div>
  );
};
