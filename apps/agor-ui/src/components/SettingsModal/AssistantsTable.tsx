import type { AgorClient } from '@agor/core/api';
import type { AssistantConfig, Board, Repo, Session, Worktree } from '@agor/core/types';
import { getAssistantConfig, isAssistant } from '@agor/core/types';
import {
  DeleteOutlined,
  EditOutlined,
  FolderOutlined,
  PlusOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { Button, Empty, Form, Input, Modal, Space, Table, Tooltip, Typography, theme } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mapToArray } from '@/utils/mapHelpers';
import { slugify } from '@/utils/repoSlug';
import { ArchiveDeleteWorktreeModal } from '../ArchiveDeleteWorktreeModal';
import { AssistantFormFields, CREATE_NEW_BOARD } from '../forms/AssistantFormFields';
import type { WorktreeUpdate } from '../WorktreeModal/tabs/GeneralTab';
import { renderEnvCell } from './WorktreeEnvColumn';

const FRAMEWORK_REPO_SLUG = 'preset-io/agor-assistant';

interface AssistantsTableProps {
  worktreeById: Map<string, Worktree>;
  repoById: Map<string, Repo>;
  boardById: Map<string, Board>;
  sessionsByWorktree: Map<string, Session[]>;
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
  onCreateRepo?: (data: { url: string; slug: string; default_branch: string }) => void;
  onStartEnvironment?: (worktreeId: string) => void;
  onStopEnvironment?: (worktreeId: string) => void;
}

export const AssistantsTable: React.FC<AssistantsTableProps> = ({
  worktreeById,
  repoById,
  boardById,
  sessionsByWorktree,
  client,
  onArchiveOrDelete,
  onRowClick,
  onCreateWorktree,
  onUpdateWorktree,
  onCreateRepo,
  onStartEnvironment,
  onStopEnvironment,
}) => {
  const repos = mapToArray(repoById);
  const boards = mapToArray(boardById);
  const { token } = theme.useToken();

  const frameworkRepo = useMemo(
    () =>
      repos.find(
        (r) =>
          r.slug === FRAMEWORK_REPO_SLUG ||
          r.remote_url?.includes('agor-assistant') ||
          r.remote_url?.includes('agor-openclaw')
      ),
    [repos]
  );

  const [customRepoSelected, setCustomRepoSelected] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [isFormValid, setIsFormValid] = useState(false);
  const [creating, setCreating] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    if (frameworkRepo && !form.getFieldValue('repoId')) {
      form.setFieldValue('repoId', frameworkRepo.repo_id);
    }
  }, [frameworkRepo, form]);

  const [archiveDeleteModalOpen, setArchiveDeleteModalOpen] = useState(false);
  const [selectedWorktree, setSelectedWorktree] = useState<Worktree | null>(null);

  const validateForm = useCallback(() => {
    const values = form.getFieldsValue();
    const hasDisplayName = !!values.displayName?.trim();
    const hasRepo = Boolean(values.repoId || frameworkRepo?.repo_id);
    setIsFormValid(hasDisplayName && hasRepo);
  }, [form, frameworkRepo]);

  const lastAutoName = useRef('');

  const handleDisplayNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const displayName = e.target.value;
    const currentName = form.getFieldValue('name');
    const autoName = `private-${slugify(displayName)}`;
    if (!currentName || currentName === lastAutoName.current) {
      form.setFieldValue('name', autoName);
      lastAutoName.current = autoName;
    }
    validateForm();
  };

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

      const repo = repoById.get(repoId);
      const worktreeName = values.name || `private-${slugify(values.displayName)}`;
      const sourceBranch = values.sourceBranch || repo?.default_branch || 'main';

      const assistantEmoji = values.emoji || undefined;
      let boardId: string | undefined;
      if (values.boardChoice === CREATE_NEW_BOARD) {
        if (client) {
          try {
            const newBoard = (await client.service('boards').create({
              name: values.displayName.trim(),
              icon: assistantEmoji || '🤖',
            })) as Board;
            boardId = newBoard.board_id;
          } catch (err) {
            console.error('Failed to create board:', err);
          }
        }
      } else if (values.boardChoice) {
        boardId = values.boardChoice;
      }

      const worktree = await onCreateWorktree?.(repoId, {
        name: worktreeName,
        ref: worktreeName,
        createBranch: true,
        sourceBranch,
        pullLatest: true,
        boardId,
      });

      if (worktree) {
        const assistantConfig: AssistantConfig = {
          kind: 'assistant',
          displayName: values.displayName.trim(),
          emoji: assistantEmoji,
          frameworkRepo: repo?.slug,
          createdViaOnboarding: false,
        };
        onUpdateWorktree?.(worktree.worktree_id, {
          custom_context: { assistant: assistantConfig },
        });
      }

      setCreateModalOpen(false);
      form.resetFields();
      setCustomRepoSelected(false);
      lastAutoName.current = '';
    } catch (error) {
      console.error('Assistant creation failed:', error);
    } finally {
      setCreating(false);
    }
  };

  const handleCancel = () => {
    setCreateModalOpen(false);
    form.resetFields();
    setIsFormValid(false);
    setCustomRepoSelected(false);
    lastAutoName.current = '';
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
      const haystacks = [config?.displayName, w.name, repo?.name, repo?.slug];
      return haystacks.some((v) => v?.toLowerCase().includes(term));
    });
  }, [worktreeById, repoById, searchTerm]);

  const columns = [
    {
      title: 'Assistant',
      key: 'assistant',
      render: (_: unknown, record: Worktree) => {
        const config = getAssistantConfig(record);
        return (
          <Space>
            {config?.emoji ? (
              <span style={{ fontSize: 18 }}>{config.emoji}</span>
            ) : (
              <RobotOutlined style={{ color: token.colorInfo }} />
            )}
            <div>
              <Typography.Text strong>{config?.displayName ?? record.name}</Typography.Text>
              <br />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {record.name}
              </Typography.Text>
            </div>
          </Space>
        );
      },
    },
    {
      title: 'Env',
      key: 'env',
      width: 120,
      align: 'center' as const,
      render: (_: unknown, record: Worktree) => {
        const repo = repos.find((r: Repo) => r.repo_id === record.repo_id);
        return renderEnvCell(record, repo, token, { onStartEnvironment, onStopEnvironment });
      },
    },
    {
      title: 'Repo',
      key: 'repo',
      render: (_: unknown, record: Worktree) => {
        const repo = repoById.get(record.repo_id);
        return (
          <Space>
            <FolderOutlined />
            <Typography.Text>{repo?.name || 'Unknown'}</Typography.Text>
          </Space>
        );
      },
    },
    {
      title: 'Branch',
      dataIndex: 'ref',
      key: 'ref',
      render: (ref: string) => <Typography.Text code>{ref}</Typography.Text>,
    },
    {
      title: 'Sessions',
      key: 'sessions',
      width: 100,
      render: (_: unknown, record: Worktree) => {
        const count = (sessionsByWorktree.get(record.worktree_id) || []).length;
        return (
          <Typography.Text type="secondary">
            {count} {count === 1 ? 'session' : 'sessions'}
          </Typography.Text>
        );
      },
    },
    {
      title: 'Path',
      key: 'path',
      width: 60,
      align: 'center' as const,
      render: (_: unknown, record: Worktree) => (
        <Typography.Text
          copyable={{
            text: record.path,
            tooltips: [`Copy path: ${record.path}`, 'Copied!'],
          }}
        />
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 100,
      render: (_: unknown, record: Worktree) => (
        <Space size="small">
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
