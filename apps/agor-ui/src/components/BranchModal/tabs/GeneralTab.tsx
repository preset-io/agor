import type { AgorClient, Board, Branch, MCPServer, Repo, Session, User } from '@agor-live/client';
import { hasMinimumRole, isAssistant, ROLES } from '@agor-live/client';
import { DeleteOutlined, FolderOutlined, LinkOutlined } from '@ant-design/icons';
import { Button, Descriptions, Form, Input, Select, Space, Tooltip, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useThemedMessage } from '../../../utils/message';
import { ArchiveDeleteBranchModal } from '../../ArchiveDeleteBranchModal';
import { MCPServerSelect } from '../../MCPServerSelect';
import { Tag } from '../../Tag';
import { OwnersSection } from '../components/OwnersSection';

const { TextArea } = Input;

export type BranchUpdate = Omit<
  Partial<Branch>,
  'issue_url' | 'pull_request_url' | 'notes' | 'board_id'
> & {
  board_id?: string | null | undefined;
  issue_url?: string | null | undefined;
  pull_request_url?: string | null | undefined;
  notes?: string | null | undefined;
};

interface GeneralTabProps {
  branch: Branch;
  repo: Repo;
  sessions: Session[]; // Used to count sessions for this branch
  boards?: Board[];
  mcpServers?: MCPServer[];
  client?: AgorClient | null;
  currentUser?: User | null;
  onUpdate?: (branchId: string, updates: BranchUpdate) => void;
  onArchiveOrDelete?: (
    branchId: string,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    }
  ) => void;
  onClose?: () => void;
}

export const GeneralTab: React.FC<GeneralTabProps> = ({
  branch,
  repo,
  sessions,
  boards = [],
  mcpServers = [],
  client = null,
  currentUser,
  onUpdate,
  onArchiveOrDelete,
  onClose,
}) => {
  const { showSuccess } = useThemedMessage();

  // Track if this is the initial mount to prevent overwriting user input
  const [isInitialized, setIsInitialized] = useState(false);
  const [boardId, setBoardId] = useState(branch.board_id || undefined);
  const [issueUrl, setIssueUrl] = useState(branch.issue_url || '');
  const [prUrl, setPrUrl] = useState(branch.pull_request_url || '');
  const [notes, setNotes] = useState(branch.notes || '');
  const [mcpServerIds, setMcpServerIds] = useState<string[]>(branch.mcp_server_ids || []);
  const [archiveDeleteModalOpen, setArchiveDeleteModalOpen] = useState(false);
  const [owners, setOwners] = useState<User[]>([]);
  const [loadingOwners, setLoadingOwners] = useState(true);

  // Only sync local state on first mount, not on every prop change (to prevent overwriting user input)
  useEffect(() => {
    if (!isInitialized) {
      setBoardId(branch.board_id || undefined);
      setIssueUrl(branch.issue_url || '');
      setPrUrl(branch.pull_request_url || '');
      setNotes(branch.notes || '');
      setMcpServerIds(branch.mcp_server_ids || []);
      setIsInitialized(true);
    }
  }, [
    isInitialized,
    branch.board_id,
    branch.issue_url,
    branch.pull_request_url,
    branch.notes,
    branch.mcp_server_ids,
  ]);

  // Load branch owners to check edit permissions
  const [rbacActive, setRbacActive] = useState(true);
  useEffect(() => {
    if (!client) {
      setLoadingOwners(false);
      return;
    }

    const loadOwners = async () => {
      try {
        setLoadingOwners(true);
        const ownersResponse = await client.service('branches/:id/owners').find({
          route: { id: branch.branch_id },
        });
        setOwners(ownersResponse as User[]);
        setRbacActive(true);
      } catch (_error) {
        // If RBAC is disabled or service not found, allow all edits
        setOwners([]);
        setRbacActive(false);
      } finally {
        setLoadingOwners(false);
      }
    };

    loadOwners();
  }, [client, branch.branch_id]);

  // Check if current user can edit this branch
  // When RBAC is disabled, all authenticated members can edit
  // When RBAC is enabled, owners and admins can edit
  const currentUserId = currentUser?.user_id;
  const isAdmin = hasMinimumRole(currentUser?.role, ROLES.ADMIN);
  const isOwner = owners.some((o) => o.user_id === currentUserId);

  const canEdit = loadingOwners ? isAdmin : !rbacActive || isAdmin || isOwner;

  const mcpChanged =
    JSON.stringify([...mcpServerIds].sort()) !==
    JSON.stringify([...(branch.mcp_server_ids || [])].sort());

  // For assistants, notes is edited as "Description" in the Assistant tab — exclude from General tab
  const isAssistantBranch = isAssistant(branch);
  const notesChanged = !isAssistantBranch && notes !== (branch.notes || '');

  const hasChanges =
    boardId !== branch.board_id ||
    issueUrl !== (branch.issue_url || '') ||
    prUrl !== (branch.pull_request_url || '') ||
    notesChanged ||
    mcpChanged;

  const handleSave = () => {
    const updates: BranchUpdate = {
      board_id: boardId || undefined,
      issue_url: (issueUrl.trim() === '' ? null : issueUrl) as string | null | undefined,
      pull_request_url: (prUrl.trim() === '' ? null : prUrl) as string | null | undefined,
      ...(!isAssistantBranch
        ? { notes: (notes.trim() === '' ? null : notes) as string | null | undefined }
        : {}),
      ...(mcpChanged ? { mcp_server_ids: mcpServerIds } : {}),
    };
    onUpdate?.(branch.branch_id, updates);
    showSuccess('Branch updated');
    onClose?.();
  };

  const handleCancel = () => {
    setBoardId(branch.board_id || undefined);
    setIssueUrl(branch.issue_url || '');
    setPrUrl(branch.pull_request_url || '');
    setNotes(branch.notes || '');
    setMcpServerIds(branch.mcp_server_ids || []);
  };

  const handleArchiveOrDelete = (options: {
    metadataAction: 'archive' | 'delete';
    filesystemAction: 'preserved' | 'cleaned' | 'deleted';
  }) => {
    onArchiveOrDelete?.(branch.branch_id, options);
  };

  return (
    <div style={{ width: '100%', maxHeight: '70vh', overflowY: 'auto' }}>
      <Space orientation="vertical" size="large" style={{ width: '100%' }}>
        {/* Basic Information */}
        <Descriptions column={1} bordered size="small">
          <Descriptions.Item label="Name">
            <Typography.Text strong>{branch.name}</Typography.Text>
            {branch.new_branch && (
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
            <Typography.Text code>{branch.ref}</Typography.Text>
          </Descriptions.Item>
          {branch.base_ref && (
            <Descriptions.Item label={branch.ref_type === 'tag' ? 'Base Tag' : 'Base Branch'}>
              <Typography.Text code>
                {branch.base_ref}
                {branch.base_sha && ` (${branch.base_sha.substring(0, 7)})`}
              </Typography.Text>
            </Descriptions.Item>
          )}
          {branch.tracking_branch && (
            <Descriptions.Item label="Tracking">
              <Typography.Text code>{branch.tracking_branch}</Typography.Text>
            </Descriptions.Item>
          )}
          {branch.last_commit_sha && (
            <Descriptions.Item label="Current SHA">
              <Typography.Text code>{branch.last_commit_sha.substring(0, 7)}</Typography.Text>
            </Descriptions.Item>
          )}
          <Descriptions.Item label="Path">
            <Typography.Text
              code
              style={{ fontSize: 11 }}
              copyable={{
                text: branch.path,
                tooltips: ['Copy path', 'Copied!'],
              }}
            >
              {branch.path}
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
                options={boards
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((board) => ({
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

            {/* Hide Notes for assistants — edited as "Description" in the Assistant tab */}
            {!isAssistant(branch) && (
              <Form.Item
                label={
                  <Space size={4}>
                    <span>Notes</span>
                    <Tooltip title="Markdown formatting supported (headings, bold, italic, lists, code blocks, etc.)">
                      <span
                        style={{
                          fontSize: '10px',
                          fontWeight: 'bold',
                          fontFamily: 'monospace',
                          opacity: 0.6,
                          cursor: 'help',
                        }}
                      >
                        MD
                      </span>
                    </Tooltip>
                  </Space>
                }
                labelCol={{ span: 6 }}
                wrapperCol={{ span: 18 }}
              >
                <TextArea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Freeform notes about this branch..."
                  rows={4}
                  disabled={!canEdit}
                />
              </Form.Item>
            )}

            <Form.Item
              label="MCP Servers"
              labelCol={{ span: 6 }}
              wrapperCol={{ span: 18 }}
              extra="Default MCP servers for new sessions in this branch"
            >
              <MCPServerSelect
                mcpServers={mcpServers}
                value={mcpServerIds}
                onChange={setMcpServerIds}
                placeholder="Select default MCP servers..."
                disabled={!canEdit}
              />
            </Form.Item>
          </Form>
        </div>

        {/* Owners & Permissions */}
        <OwnersSection branch={branch} client={client} currentUser={currentUser} />

        {/* Timestamps */}
        <Descriptions column={2} bordered size="small">
          <Descriptions.Item label="Created">
            {new Date(branch.created_at).toLocaleString()}
          </Descriptions.Item>
          <Descriptions.Item label="Last Used">
            {branch.last_used ? new Date(branch.last_used).toLocaleString() : 'Never'}
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
            Archive/Delete Branch
          </Button>
          {/* TODO: Add "Open in Terminal" button once terminal integration is ready */}
        </Space>
        <ArchiveDeleteBranchModal
          open={archiveDeleteModalOpen}
          branch={branch}
          sessionCount={sessions.length}
          environmentRunning={branch.environment_instance?.status === 'running'}
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
