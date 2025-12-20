import type { AgorClient } from '@agor/core/api';
import type { Board, Repo, Session, User, Worktree } from '@agor/core/types';
import { DeleteOutlined, FolderOutlined, LinkOutlined } from '@ant-design/icons';
import { Button, Descriptions, Form, Input, Select, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useThemedMessage } from '../../../utils/message';
import { ArchiveDeleteWorktreeModal } from '../../ArchiveDeleteWorktreeModal';
import { Tag } from '../../Tag';
import { OwnersSection } from '../components/OwnersSection';

const { TextArea } = Input;

export type WorktreeUpdate = Omit<
  Partial<Worktree>,
  'issue_url' | 'pull_request_url' | 'notes' | 'board_id'
> & {
  board_id?: string | null | undefined;
  issue_url?: string | null | undefined;
  pull_request_url?: string | null | undefined;
  notes?: string | null | undefined;
};

interface GeneralTabProps {
  worktree: Worktree;
  repo: Repo;
  sessions: Session[]; // Used to count sessions for this worktree
  boards?: Board[];
  client?: AgorClient | null;
  currentUser?: User | null;
  onUpdate?: (worktreeId: string, updates: WorktreeUpdate) => void;
  onArchiveOrDelete?: (
    worktreeId: string,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    }
  ) => void;
  onClose?: () => void;
}

export const GeneralTab: React.FC<GeneralTabProps> = ({
  worktree,
  repo,
  sessions,
  boards = [],
  client = null,
  currentUser,
  onUpdate,
  onArchiveOrDelete,
  onClose,
}) => {
  const { showSuccess } = useThemedMessage();

  // Track if this is the initial mount to prevent overwriting user input
  const [isInitialized, setIsInitialized] = useState(false);
  const [boardId, setBoardId] = useState(worktree.board_id || undefined);
  const [issueUrl, setIssueUrl] = useState(worktree.issue_url || '');
  const [prUrl, setPrUrl] = useState(worktree.pull_request_url || '');
  const [notes, setNotes] = useState(worktree.notes || '');
  const [archiveDeleteModalOpen, setArchiveDeleteModalOpen] = useState(false);
  const [owners, setOwners] = useState<User[]>([]);
  const [loadingOwners, setLoadingOwners] = useState(true);

  // Only sync local state on first mount, not on every prop change (to prevent overwriting user input)
  useEffect(() => {
    if (!isInitialized) {
      setBoardId(worktree.board_id || undefined);
      setIssueUrl(worktree.issue_url || '');
      setPrUrl(worktree.pull_request_url || '');
      setNotes(worktree.notes || '');
      setIsInitialized(true);
    }
  }, [
    isInitialized,
    worktree.board_id,
    worktree.issue_url,
    worktree.pull_request_url,
    worktree.notes,
  ]);

  // Load worktree owners to check edit permissions
  useEffect(() => {
    if (!client) {
      setLoadingOwners(false);
      return;
    }

    const loadOwners = async () => {
      try {
        setLoadingOwners(true);
        const ownersResponse = await client.service('worktrees/:id/owners').find({
          route: { id: worktree.worktree_id },
        });
        setOwners(ownersResponse as User[]);
      } catch (_error) {
        // If RBAC is disabled or service not found, allow all edits
        console.log('Could not load owners, allowing edits');
        setOwners([]);
      } finally {
        setLoadingOwners(false);
      }
    };

    loadOwners();
  }, [client, worktree.worktree_id]);

  // Check if current user can edit this worktree
  // Owners can edit, AND admins have super powers (can edit any worktree)
  const currentUserId = currentUser?.user_id;
  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'owner';
  const isOwner = owners.some((o) => o.user_id === currentUserId);

  // While loading, assume admins can edit (we know their role immediately)
  // After loading, check ownership OR admin status
  const canEdit = loadingOwners ? isAdmin : isAdmin || isOwner;

  const hasChanges =
    boardId !== worktree.board_id ||
    issueUrl !== (worktree.issue_url || '') ||
    prUrl !== (worktree.pull_request_url || '') ||
    notes !== (worktree.notes || '');

  const handleSave = () => {
    const updates = {
      board_id: boardId || undefined,
      issue_url: (issueUrl.trim() === '' ? null : issueUrl) as string | null | undefined,
      pull_request_url: (prUrl.trim() === '' ? null : prUrl) as string | null | undefined,
      notes: (notes.trim() === '' ? null : notes) as string | null | undefined,
    };
    onUpdate?.(worktree.worktree_id, updates);
    showSuccess('Worktree updated');
    onClose?.();
  };

  const handleCancel = () => {
    setBoardId(worktree.board_id || undefined);
    setIssueUrl(worktree.issue_url || '');
    setPrUrl(worktree.pull_request_url || '');
    setNotes(worktree.notes || '');
  };

  const handleArchiveOrDelete = (options: {
    metadataAction: 'archive' | 'delete';
    filesystemAction: 'preserved' | 'cleaned' | 'deleted';
  }) => {
    onArchiveOrDelete?.(worktree.worktree_id, options);
  };

  return (
    <div style={{ width: '100%', maxHeight: '70vh', overflowY: 'auto' }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        {/* Basic Information */}
        <Descriptions column={1} bordered size="small">
          <Descriptions.Item label="Name">
            <Typography.Text strong>{worktree.name}</Typography.Text>
            {worktree.new_branch && (
              <Tag color="green" style={{ marginLeft: 8, fontSize: 11 }}>
                New Branch
              </Tag>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="Repository">
            <Space>
              <FolderOutlined />
              <Typography.Text>{repo.name}</Typography.Text>
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="Branch">
            <Typography.Text code>{worktree.ref}</Typography.Text>
          </Descriptions.Item>
          {worktree.base_ref && (
            <Descriptions.Item label={worktree.ref_type === 'tag' ? 'Base Tag' : 'Base Branch'}>
              <Typography.Text code>
                {worktree.base_ref}
                {worktree.base_sha && ` (${worktree.base_sha.substring(0, 7)})`}
              </Typography.Text>
            </Descriptions.Item>
          )}
          {worktree.tracking_branch && (
            <Descriptions.Item label="Tracking">
              <Typography.Text code>{worktree.tracking_branch}</Typography.Text>
            </Descriptions.Item>
          )}
          {worktree.last_commit_sha && (
            <Descriptions.Item label="Current SHA">
              <Typography.Text code>{worktree.last_commit_sha.substring(0, 7)}</Typography.Text>
            </Descriptions.Item>
          )}
          <Descriptions.Item label="Path">
            <Typography.Text
              code
              style={{ fontSize: 11 }}
              copyable={{
                text: worktree.path,
                tooltips: ['Copy path', 'Copied!'],
              }}
            >
              {worktree.path}
            </Typography.Text>
          </Descriptions.Item>
        </Descriptions>

        {/* Work Context */}
        <div>
          <Typography.Text strong style={{ fontSize: 14, display: 'block', marginBottom: 16 }}>
            Work Context
          </Typography.Text>
          <Form layout="horizontal" colon={false}>
            <Form.Item label="Board" labelCol={{ span: 6 }} wrapperCol={{ span: 18 }}>
              <Select
                value={boardId}
                onChange={setBoardId}
                placeholder="Select board (optional)..."
                allowClear
                disabled={!canEdit}
                options={boards.map((board) => ({
                  value: board.board_id,
                  label: `${board.icon || '📋'} ${board.name}`,
                }))}
              />
            </Form.Item>

            <Form.Item label="Issue" labelCol={{ span: 6 }} wrapperCol={{ span: 18 }}>
              <Input
                value={issueUrl}
                onChange={(e) => setIssueUrl(e.target.value)}
                placeholder="https://github.com/user/repo/issues/42"
                prefix={<LinkOutlined />}
                disabled={!canEdit}
              />
            </Form.Item>

            <Form.Item label="Pull Request" labelCol={{ span: 6 }} wrapperCol={{ span: 18 }}>
              <Input
                value={prUrl}
                onChange={(e) => setPrUrl(e.target.value)}
                placeholder="https://github.com/user/repo/pull/43"
                prefix={<LinkOutlined />}
                disabled={!canEdit}
              />
            </Form.Item>

            <Form.Item label="Notes" labelCol={{ span: 6 }} wrapperCol={{ span: 18 }}>
              <TextArea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Freeform notes about this worktree..."
                rows={4}
                disabled={!canEdit}
              />
            </Form.Item>
          </Form>
        </div>

        {/* Owners & Permissions */}
        <OwnersSection worktree={worktree} client={client} currentUser={currentUser} />

        {/* Timestamps */}
        <Descriptions column={2} bordered size="small">
          <Descriptions.Item label="Created">
            {new Date(worktree.created_at).toLocaleString()}
          </Descriptions.Item>
          <Descriptions.Item label="Last Used">
            {worktree.last_used ? new Date(worktree.last_used).toLocaleString() : 'Never'}
          </Descriptions.Item>
        </Descriptions>

        {/* Actions */}
        <Space>
          <Button type="primary" onClick={handleSave} disabled={!hasChanges || !canEdit}>
            Save Changes
          </Button>
          <Button onClick={handleCancel} disabled={!hasChanges}>
            Cancel
          </Button>
          <Button
            danger
            icon={<DeleteOutlined />}
            onClick={() => setArchiveDeleteModalOpen(true)}
            disabled={!canEdit}
          >
            Archive/Delete Worktree
          </Button>
          {/* TODO: Add "Open in Terminal" button once terminal integration is ready */}
        </Space>
        <ArchiveDeleteWorktreeModal
          open={archiveDeleteModalOpen}
          worktree={worktree}
          sessionCount={sessions.length}
          environmentRunning={worktree.environment_instance?.status === 'running'}
          onConfirm={(options) => {
            handleArchiveOrDelete(options);
            setArchiveDeleteModalOpen(false);
          }}
          onCancel={() => setArchiveDeleteModalOpen(false)}
        />
      </Space>
    </div>
  );
};
