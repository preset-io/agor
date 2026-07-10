import type { Board, Branch, MCPServer, Repo, Session } from '@agor-live/client';
import { isTeammate } from '@agor-live/client';
import { FolderOutlined, LinkOutlined } from '@ant-design/icons';
import { Descriptions, Form, Input, Select, Space, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { ArchiveActionButton } from '../../ArchiveButton';
import { ArchiveDeleteBranchModal } from '../../ArchiveDeleteBranchModal';
import { MCPServerSelect } from '../../MCPServerSelect';
import { Tag } from '../../Tag';
import type { GeneralFormState } from '../useBranchModalForm';

// Re-exported so external consumers can keep importing the patch-shape type
// from the same path. Canonical definition lives in `useBranchModalForm`.
export type { BranchUpdate } from '../useBranchModalForm';

const { TextArea } = Input;

interface GeneralTabProps {
  branch: Branch;
  repo: Repo;
  sessions: Session[]; // Used to gauge environment risk on Archive/Delete
  boards?: Board[];
  mcpServers?: MCPServer[];
  canEdit: boolean;
  state: GeneralFormState;
  setField: <K extends keyof GeneralFormState>(key: K, value: GeneralFormState[K]) => void;
  onArchiveOrDelete?: (
    branchId: string,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    }
  ) => void;
}

export const GeneralTab: React.FC<GeneralTabProps> = ({
  branch,
  repo,
  sessions,
  boards = [],
  mcpServers = [],
  canEdit,
  state,
  setField,
  onArchiveOrDelete,
}) => {
  const [archiveDeleteModalOpen, setArchiveDeleteModalOpen] = useState(false);

  const handleArchiveOrDelete = (options: {
    metadataAction: 'archive' | 'delete';
    filesystemAction: 'preserved' | 'cleaned' | 'deleted';
  }) => {
    onArchiveOrDelete?.(branch.branch_id, options);
  };

  const isTeammateBranch = isTeammate(branch);

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
                value={state.boardId}
                onChange={(value) => setField('boardId', value)}
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
                value={state.issueUrl}
                onChange={(e) => setField('issueUrl', e.target.value)}
                placeholder="https://github.com/user/repo/issues/42"
                prefix={<LinkOutlined />}
                disabled={!canEdit}
              />
            </Form.Item>

            <Form.Item label="Pull Request" labelCol={{ span: 6 }} wrapperCol={{ span: 18 }}>
              <Input
                value={state.prUrl}
                onChange={(e) => setField('prUrl', e.target.value)}
                placeholder="https://github.com/user/repo/pull/43"
                prefix={<LinkOutlined />}
                disabled={!canEdit}
              />
            </Form.Item>

            {/* Hide Notes for teammates — edited as "Description" in the Teammate tab */}
            {!isTeammateBranch && (
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
                  value={state.notes}
                  onChange={(e) => setField('notes', e.target.value)}
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
                value={state.mcpServerIds}
                onChange={(value) => setField('mcpServerIds', value)}
                placeholder="Select default MCP servers..."
                disabled={!canEdit}
              />
            </Form.Item>
          </Form>
        </div>

        {/* Timestamps */}
        <Descriptions column={2} bordered size="small">
          <Descriptions.Item label="Created">
            {new Date(branch.created_at).toLocaleString()}
          </Descriptions.Item>
          <Descriptions.Item label="Last Used">
            {branch.last_used ? new Date(branch.last_used).toLocaleString() : 'Never'}
          </Descriptions.Item>
        </Descriptions>

        {/* Out-of-band destructive action: archive/delete is not part of the
            modal's Save flow because it tears the branch down entirely. */}
        <Space>
          <ArchiveActionButton
            tooltip=""
            size="middle"
            onClick={() => setArchiveDeleteModalOpen(true)}
            disabled={!canEdit}
          >
            Archive or Delete Branch
          </ArchiveActionButton>
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
