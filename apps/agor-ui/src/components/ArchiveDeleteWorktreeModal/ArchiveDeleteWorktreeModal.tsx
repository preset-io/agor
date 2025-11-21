import type { Worktree } from '@agor/core/types';
import { Alert, Modal, Radio, Space, Typography } from 'antd';
import { useState } from 'react';

const { Text } = Typography;

interface ArchiveDeleteWorktreeModalProps {
  open: boolean;
  worktree: Worktree;
  sessionCount?: number;
  environmentRunning?: boolean;
  onConfirm: (options: {
    metadataAction: 'archive' | 'delete';
    filesystemAction: 'preserved' | 'cleaned' | 'deleted';
  }) => void;
  onCancel: () => void;
}

export const ArchiveDeleteWorktreeModal: React.FC<ArchiveDeleteWorktreeModalProps> = ({
  open,
  worktree,
  sessionCount = 0,
  environmentRunning = false,
  onConfirm,
  onCancel,
}) => {
  const [filesystemAction, setFilesystemAction] = useState<'preserved' | 'cleaned' | 'deleted'>(
    'cleaned'
  );
  const [metadataAction, setMetadataAction] = useState<'archive' | 'delete'>('archive');

  const handleOk = () => {
    onConfirm({ metadataAction, filesystemAction });
  };

  // Determine button text and style based on metadata action
  const okText = metadataAction === 'archive' ? 'Archive Worktree' : 'Delete Permanently';
  const okButtonProps = metadataAction === 'delete' ? { danger: true } : {};

  return (
    <Modal
      title="Archive or Delete Worktree"
      open={open}
      onOk={handleOk}
      onCancel={onCancel}
      okText={okText}
      okButtonProps={okButtonProps}
      cancelText="Cancel"
      width={600}
    >
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        {/* Worktree Info */}
        <div>
          <Text strong>Worktree: </Text>
          <Text code>{worktree.name}</Text>
          <br />
          <Text strong>Branch: </Text>
          <Text>{worktree.ref}</Text>
        </div>

        {/* Environment Warning */}
        {environmentRunning && (
          <Alert
            message="Environment is running and will be stopped"
            type="warning"
            showIcon
            style={{ marginBottom: 0 }}
          />
        )}

        {/* Filesystem Options */}
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            Filesystem
          </Text>
          <Radio.Group value={filesystemAction} onChange={e => setFilesystemAction(e.target.value)}>
            <Space direction="vertical">
              <Radio value="preserved">
                <div>
                  <div>Leave untouched</div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    No changes to disk
                  </Text>
                </div>
              </Radio>
              <Radio value="cleaned">
                <div>
                  <div>Clean workspace (git clean -fdx)</div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Removes node_modules, builds, untracked files
                  </Text>
                </div>
              </Radio>
              <Radio value="deleted">
                <div>
                  <div>Delete completely</div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Removes entire worktree directory from disk
                  </Text>
                </div>
              </Radio>
            </Space>
          </Radio.Group>
        </div>

        {/* Metadata Options */}
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            Metadata & Sessions
          </Text>
          <Radio.Group value={metadataAction} onChange={e => setMetadataAction(e.target.value)}>
            <Space direction="vertical">
              <Radio value="archive">
                <div>
                  <div>Archive (recommended)</div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Hidden from board, data preserved for analytics and history
                  </Text>
                </div>
              </Radio>
              <Radio value="delete">
                <div>
                  <div>Delete permanently</div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    All data deleted - no undo
                  </Text>
                </div>
              </Radio>
            </Space>
          </Radio.Group>
        </div>

        {/* Delete Warning */}
        {metadataAction === 'delete' && (
          <Alert
            message="Warning"
            description={
              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                <Text>
                  • All {sessionCount} session(s), messages, and history will be permanently deleted
                </Text>
                <Text>• Token usage data will be lost - prevents analytics and cost tracking</Text>
                <Text>• Links to issues/PRs will be removed forever</Text>
                <Text>• This action cannot be undone</Text>
                <Text strong style={{ marginTop: 8, display: 'block' }}>
                  💡 Consider archiving instead - keeps data for history but hides from board
                </Text>
              </Space>
            }
            type="error"
            showIcon
          />
        )}

        {/* Path Display */}
        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Path:{' '}
          </Text>
          <Text code copyable style={{ fontSize: 11 }}>
            {worktree.path}
          </Text>
        </div>
      </Space>
    </Modal>
  );
};
