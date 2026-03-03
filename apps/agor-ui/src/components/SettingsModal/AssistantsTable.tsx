import type { AgorClient } from '@agor/core/api';
import type { AssistantConfig, Board, Repo, Session, Worktree } from '@agor/core/types';
import { getAssistantConfig, isAssistant } from '@agor/core/types';
import {
  DeleteOutlined,
  EditOutlined,
  FolderOutlined,
  PlusOutlined,
  RobotOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Collapse,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { useCallback, useMemo, useState } from 'react';
import { mapToArray } from '@/utils/mapHelpers';
import { ArchiveDeleteWorktreeModal } from '../ArchiveDeleteWorktreeModal';
import type { WorktreeUpdate } from '../WorktreeModal/tabs/GeneralTab';
import { renderEnvCell } from './WorktreeEnvColumn';

const FRAMEWORK_REPO_SLUG = 'preset-io/agor-assistant';

/** Special sentinel for "create new board" option */
const CREATE_NEW_BOARD = '__create_new__';

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
  onStartEnvironment?: (worktreeId: string) => void;
  onStopEnvironment?: (worktreeId: string) => void;
}

/** Slugify a display name into a valid worktree name */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
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
  onStartEnvironment,
  onStopEnvironment,
}) => {
  const repos = mapToArray(repoById);
  const boards = mapToArray(boardById);
  const { token } = theme.useToken();

  // Find the framework repo if available
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

  // Create modal state
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [isFormValid, setIsFormValid] = useState(false);
  const [creating, setCreating] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  // Archive/delete modal
  const [archiveDeleteModalOpen, setArchiveDeleteModalOpen] = useState(false);
  const [selectedWorktree, setSelectedWorktree] = useState<Worktree | null>(null);

  const validateForm = useCallback(() => {
    const values = form.getFieldsValue();
    const hasDisplayName = !!values.displayName?.trim();
    // Repo defaults to framework repo, so always valid unless advanced override clears it
    const hasRepo = frameworkRepo ? true : !!values.repoId;
    setIsFormValid(hasDisplayName && hasRepo);
  }, [form, frameworkRepo]);

  // Auto-generate worktree name from display name
  const handleDisplayNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const displayName = e.target.value;
    const currentName = form.getFieldValue('name');
    const prevDisplayName = form.getFieldValue('displayName');
    const autoName = `private-${slugify(displayName)}`;
    const prevAutoName = prevDisplayName ? `private-${slugify(prevDisplayName)}` : '';
    if (!currentName || currentName === prevAutoName) {
      form.setFieldValue('name', autoName);
    }
    validateForm();
  };

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      setCreating(true);

      // Resolve repo — default to framework repo
      const repoId = values.repoId || frameworkRepo?.repo_id;
      if (!repoId) return;

      const repo = repoById.get(repoId);
      const worktreeName = values.name || `private-${slugify(values.displayName)}`;
      const sourceBranch = values.sourceBranch || repo?.default_branch || 'main';

      // Resolve board — create new or use existing
      let boardId: string | undefined;
      if (values.boardChoice === CREATE_NEW_BOARD) {
        // Create a new board named after the assistant
        if (client) {
          try {
            const newBoard = (await client.service('boards').create({
              name: values.displayName.trim(),
              icon: '\u{1F916}',
            })) as Board;
            boardId = newBoard.board_id;
          } catch (err) {
            console.error('Failed to create board:', err);
          }
        }
      } else if (values.boardChoice) {
        boardId = values.boardChoice;
      }

      // Step 1: Create the worktree
      const worktree = await onCreateWorktree?.(repoId, {
        name: worktreeName,
        ref: worktreeName,
        createBranch: true,
        sourceBranch,
        pullLatest: true,
        boardId,
      });

      if (worktree) {
        // Step 2: Tag as assistant
        const assistantConfig: AssistantConfig = {
          kind: 'assistant',
          displayName: values.displayName.trim(),
          frameworkRepo: repo?.slug,
          createdViaOnboarding: false,
        };
        onUpdateWorktree?.(worktree.worktree_id, {
          custom_context: { assistant: assistantConfig },
        });
      }

      setCreateModalOpen(false);
      form.resetFields();
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
  };

  // Filter to only assistant worktrees
  const assistants = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    const assistantWorktrees = Array.from(worktreeById.values())
      .filter((w) => !w.archived && isAssistant(w))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

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
            <RobotOutlined style={{ color: token.colorInfo }} />
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

  // Board options: "Create new" first, then existing boards
  const boardOptions = [
    {
      value: CREATE_NEW_BOARD,
      label: '+ Create a new board for this assistant (Recommended)',
    },
    ...boards.map((board: Board) => ({
      value: board.board_id,
      label: `${board.icon || '\u{1F4CB}'} ${board.name}`,
    })),
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
          initialValues={{ boardChoice: CREATE_NEW_BOARD }}
        >
          <Form.Item
            name="displayName"
            label="Display Name"
            rules={[{ required: true, message: 'Please enter a display name' }]}
            tooltip="Human-friendly name for this assistant"
          >
            <Input
              placeholder="e.g. PR Reviewer, Command Center"
              autoFocus
              onChange={handleDisplayNameChange}
            />
          </Form.Item>

          <Form.Item name="boardChoice" label="Board">
            <Select
              showSearch
              filterOption={(input, option) =>
                String(option?.label ?? '')
                  .toLowerCase()
                  .includes(input.toLowerCase())
              }
              options={boardOptions}
            />
          </Form.Item>

          <Alert
            type="info"
            showIcon={false}
            style={{ marginBottom: 16 }}
            message={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                While assistants can act across boards, we recommend giving each assistant its own
                board.
              </Typography.Text>
            }
          />

          {/* Advanced options — collapsed by default */}
          <Collapse
            ghost
            size="small"
            items={[
              {
                key: 'advanced',
                label: (
                  <Space>
                    <SettingOutlined />
                    <Typography.Text type="secondary">Advanced</Typography.Text>
                  </Space>
                ),
                children: (
                  <>
                    <Form.Item name="repoId" label="Framework Repository">
                      <Select
                        placeholder={
                          frameworkRepo
                            ? `${frameworkRepo.name || frameworkRepo.slug} (default)`
                            : 'Select repository...'
                        }
                        allowClear
                        showSearch
                        filterOption={(input, option) =>
                          String(option?.label ?? '')
                            .toLowerCase()
                            .includes(input.toLowerCase())
                        }
                        options={repos
                          .sort((a, b) => (a.name || a.slug).localeCompare(b.name || b.slug))
                          .map((repo: Repo) => ({
                            value: repo.repo_id,
                            label: repo.name || repo.slug,
                          }))}
                      />
                    </Form.Item>

                    <Form.Item
                      name="name"
                      label="Worktree Name"
                      rules={[
                        {
                          pattern: /^[a-z0-9-]+$/,
                          message: 'Only lowercase letters, numbers, and hyphens allowed',
                        },
                      ]}
                      tooltip="Auto-generated from display name. Override if needed."
                    >
                      <Input placeholder="private-my-assistant" />
                    </Form.Item>

                    <Form.Item name="sourceBranch" label="Source Branch">
                      <Input
                        placeholder={
                          frameworkRepo ? frameworkRepo.default_branch || 'main' : 'main'
                        }
                      />
                    </Form.Item>
                  </>
                ),
              },
            ]}
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
