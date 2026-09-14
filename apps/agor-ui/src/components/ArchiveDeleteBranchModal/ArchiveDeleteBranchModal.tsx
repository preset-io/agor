import type {
  AgorClient,
  Branch,
  BranchArchiveOrDeleteOptions,
  BranchFilesystemAction,
  BranchMetadataAction,
  Repo,
  User,
} from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { Alert, Button, Modal, Radio, Space, Typography } from 'antd';
import { useEffect, useId, useState } from 'react';
import { BranchCleanupWarning } from '../BranchCleanupWarning';
import { RepoCleanupSettingsModal } from './RepoCleanupSettingsModal';
import { useCleanupPolicy } from './useCleanupPolicy';

const { Text } = Typography;

interface ArchiveDeleteBranchModalProps {
  client?: AgorClient | null;
  currentUser?: User | null;
  open: boolean;
  branch: Branch;
  sessionCount?: number;
  environmentRunning?: boolean;
  initialMetadataAction?: BranchMetadataAction;
  onConfirm: (options: BranchArchiveOrDeleteOptions) => void;
  onCancel: () => void;
  afterClose?: () => void;
}

export const ArchiveDeleteBranchModal: React.FC<ArchiveDeleteBranchModalProps> = ({
  client = null,
  currentUser,
  open,
  branch,
  sessionCount = 0,
  environmentRunning = false,
  initialMetadataAction = 'archive',
  onConfirm,
  onCancel,
  afterClose,
}) => {
  const radioGroupId = useId();
  const [filesystemAction, setFilesystemAction] = useState<BranchFilesystemAction>('preserved');
  const [selectionTouched, setSelectionTouched] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsRepo, setSettingsRepo] = useState<Repo | null>(null);
  const cleanup = useCleanupPolicy(client, currentUser, branch, open);
  const canConfigure = hasMinimumRole(currentUser?.role, ROLES.ADMIN);
  const [metadataAction, setMetadataAction] = useState<BranchMetadataAction>(initialMetadataAction);

  // biome-ignore lint/correctness/useExhaustiveDependencies: A new target must reset the previous branch's choices and settings draft.
  useEffect(() => {
    if (open) {
      setMetadataAction(branch.deletion_status ? 'delete' : initialMetadataAction);
      setFilesystemAction('preserved');
      setSelectionTouched(false);
      setSettingsOpen(false);
      setSettingsRepo(null);
    }
  }, [initialMetadataAction, open, branch.branch_id, branch.deletion_status]);

  useEffect(() => {
    if (!open) return;
    if (selectionTouched && cleanup.reason)
      setFilesystemAction((previous) => (previous === 'cleaned' ? 'preserved' : previous));
  }, [open, cleanup.reason, selectionTouched]);

  // Derive the untouched default from current eligibility, rather than racing
  // asynchronous policy refreshes against another state update.
  const selectedFilesystemAction =
    !selectionTouched || (filesystemAction === 'cleaned' && cleanup.reason)
      ? cleanup.reason
        ? 'preserved'
        : 'cleaned'
      : filesystemAction;

  const handleOk = () => {
    if (metadataAction === 'archive' && selectedFilesystemAction === 'cleaned' && cleanup.reason)
      return;
    onConfirm(
      metadataAction === 'delete'
        ? { metadataAction: 'delete', filesystemAction: 'deleted' }
        : { metadataAction: 'archive', filesystemAction: selectedFilesystemAction }
    );
  };

  // Determine button text and style based on metadata action
  const okText = metadataAction === 'archive' ? 'Archive Branch' : 'Delete Permanently';
  const okButtonProps = metadataAction === 'delete' ? { danger: true } : {};

  return (
    <Modal
      title="Archive or Delete Branch"
      open={open}
      onOk={handleOk}
      onCancel={onCancel}
      afterClose={afterClose}
      okText={okText}
      okButtonProps={okButtonProps}
      cancelText="Cancel"
      width={600}
    >
      <Space orientation="vertical" size="large" style={{ width: '100%' }}>
        {/* Branch Info */}
        <div>
          <Text strong>Name: </Text>
          <Text code>{branch.name}</Text>
          <br />
          <Text strong>Git ref: </Text>
          <Text>{branch.ref}</Text>
        </div>

        {branch.deletion_status && (
          <Alert
            type={branch.deletion_status === 'deletion_failed' ? 'error' : 'info'}
            title={
              branch.deletion_status === 'deletion_failed'
                ? 'Deletion failed'
                : 'Deletion in progress'
            }
            description={
              branch.deletion_error || 'The branch remains unavailable until deletion finishes.'
            }
          />
        )}
        {/* Environment Warning */}
        {environmentRunning && (
          <Alert
            title={
              metadataAction === 'delete'
                ? 'Stop the environment before requesting deletion'
                : 'Stop the environment before archiving'
            }
            type="warning"
            showIcon
            style={{ marginBottom: 0 }}
          />
        )}

        {metadataAction === 'archive' && selectedFilesystemAction === 'cleaned' && (
          <BranchCleanupWarning />
        )}

        {/* Filesystem Options */}
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            Filesystem
          </Text>
          <Radio.Group
            name={`${radioGroupId}-filesystem`}
            value={metadataAction === 'delete' ? 'deleted' : selectedFilesystemAction}
            disabled={metadataAction === 'delete'}
            onChange={(e) => {
              setSelectionTouched(true);
              setFilesystemAction(e.target.value);
            }}
          >
            <Space orientation="vertical">
              <Radio value="preserved">
                <div>
                  <div>Leave untouched</div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    No changes to disk
                  </Text>
                </div>
              </Radio>
              <Radio value="cleaned" disabled={!!cleanup.reason}>
                <div>
                  <div>Clean — {cleanup.policy?.command || 'repository cleanup command'}</div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {cleanup.reason ||
                      'Runs the configured command. Files may be deleted; there is no undo.'}
                  </Text>
                </div>
              </Radio>
              <Radio value="deleted">
                <div>
                  <div>Delete completely</div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Removes entire branch directory from disk
                  </Text>
                </div>
              </Radio>
            </Space>
          </Radio.Group>
        </div>

        {metadataAction === 'archive' && cleanup.reason && (
          <Alert
            type="warning"
            showIcon
            title={
              cleanup.policy?.enabled === false && selectedFilesystemAction === 'preserved'
                ? 'Cleanup is disabled for this repository. Archiving will keep workspace files on disk.'
                : cleanup.reason
            }
            description={
              canConfigure ? undefined : 'A repository administrator can configure branch cleanup.'
            }
            action={
              canConfigure &&
              cleanup.repo && (
                <Button
                  onClick={() => {
                    setSettingsRepo(cleanup.repo ?? null);
                    setSettingsOpen(true);
                  }}
                >
                  Open repository settings
                </Button>
              )
            }
          />
        )}

        {/* Metadata Options */}
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            Metadata & Sessions
          </Text>
          <Radio.Group
            name={`${radioGroupId}-metadata`}
            value={metadataAction}
            onChange={(e) => setMetadataAction(e.target.value)}
          >
            <Space orientation="vertical">
              <Radio value="archive" disabled={!!branch.deletion_status}>
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
                    Owned branch data and files deleted — no undo
                  </Text>
                </div>
              </Radio>
            </Space>
          </Radio.Group>
        </div>

        {/* Delete Warning */}
        {metadataAction === 'delete' && (
          <Alert
            title="Warning"
            description={
              <Space orientation="vertical" size="small" style={{ width: '100%' }}>
                <Text>
                  • All {sessionCount} session(s), messages, and history will be permanently deleted
                </Text>
                <Text>• Token usage data will be lost - prevents analytics and cost tracking</Text>
                <Text>• Workspace, branch SDK home, and owned uploads will be removed</Text>
                <Text>• Shared resources and remote Git history are retained</Text>
                <Text>
                  • This action cannot be undone; partial failures remain visible for recovery
                </Text>
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
            {branch.path}
          </Text>
        </div>
      </Space>
      {client && currentUser && settingsRepo && canConfigure && settingsOpen && (
        <RepoCleanupSettingsModal
          client={client}
          user={currentUser}
          repo={settingsRepo}
          open={settingsOpen}
          onCancel={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false);
            cleanup.refresh();
          }}
        />
      )}
    </Modal>
  );
};
