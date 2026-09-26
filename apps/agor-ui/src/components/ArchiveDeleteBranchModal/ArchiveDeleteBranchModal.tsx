import type {
  AgorClient,
  Branch,
  BranchArchiveOrDeleteOptions,
  BranchFilesystemAction,
  BranchMetadataAction,
  Repo,
  User,
} from '@agor-live/client';
import { hasMinimumRole, isTeammate, ROLES } from '@agor-live/client';
import { Alert, Button, Modal, Radio, Space, Typography } from 'antd';
import { useEffect, useId, useState } from 'react';
import {
  useAuthenticatedAuthorityScope,
  useAuthorityOperationGuard,
} from '../../hooks/useAuthorityOperationGuard';
import { useThemedMessage } from '../../utils/message';
import { BranchCleanupWarning } from '../BranchCleanupWarning';
import { RepoCleanupSettingsModal } from './RepoCleanupSettingsModal';
import { useArchiveDeleteEligibility } from './useArchiveDeleteEligibility';

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
  const eligibility = useArchiveDeleteEligibility(client, currentUser, branch, open);
  const authority = useAuthenticatedAuthorityScope(
    client,
    currentUser ? `${currentUser.user_id}:${currentUser.role}` : null
  );
  const guard = useAuthorityOperationGuard(
    authority.operationScope ? [...authority.operationScope, branch.branch_id, open] : null
  );
  const connectionDisabled = !authority.connectionReady;
  const { showSuccess } = useThemedMessage();
  const [primaryAction, setPrimaryAction] = useState<'clear' | 'retire' | null>(null);
  const [confirmPrimary, setConfirmPrimary] = useState<'clear' | 'retire' | null>(null);
  const [primaryError, setPrimaryError] = useState<string>();
  const teammate = isTeammate(branch) && !branch.archived;
  // Unavailable board data is unknown, not proof this teammate is non-primary.
  // The server independently enforces clearance before admitting retirement.
  const boardPrimary = eligibility.board
    ? eligibility.board.primary_teammate_id === branch.branch_id
    : undefined;
  const ownPrimary = currentUser?.primary_teammate_id === branch.branch_id;
  const primaryReason = teammate
    ? 'For an active teammate, use explicit file-preserving retirement below. Permanent deletion is available after retirement.'
    : undefined;
  const primaryDisabled = !!eligibility.managementReason || connectionDisabled || !!primaryAction;
  const boardActionDisabled = connectionDisabled || !!primaryAction || !eligibility.canEditBoard;
  const runPrimaryAction = async (action: 'clear' | 'retire') => {
    if (!client || (action === 'clear' ? boardActionDisabled : primaryDisabled || boardPrimary))
      return;
    const operation = guard.begin();
    if (!operation.isCurrent()) return;
    setPrimaryAction(action);
    setPrimaryError(undefined);
    try {
      if (action === 'clear' && eligibility.board && eligibility.canEditBoard) {
        await client.service('boards').clearPrimaryTeammate(eligibility.board.board_id);
        if (operation.isCurrent()) {
          setConfirmPrimary(null);
          eligibility.refresh();
        }
      } else if (action === 'retire') {
        await client.service(`branches/${branch.branch_id}/retire-teammate`).create({});
        if (operation.isCurrent()) {
          setConfirmPrimary(null);
          showSuccess('Teammate retired; files preserved');
          onCancel();
        }
      }
    } catch (error) {
      if (!operation.isCurrent()) return;
      setPrimaryError(
        error instanceof Error ? error.message : 'Teammate action failed. Refresh and try again.'
      );
      eligibility.refresh();
    } finally {
      if (operation.isCurrent()) setPrimaryAction(null);
    }
  };
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
      setPrimaryError(undefined);
      setPrimaryAction(null);
      setConfirmPrimary(null);
    }
  }, [
    initialMetadataAction,
    open,
    branch.branch_id,
    branch.deletion_status,
    authority.operationScope,
  ]);

  useEffect(() => {
    if (!open) return;
    if (selectionTouched && eligibility.cleanupReason)
      setFilesystemAction((previous) => (previous === 'cleaned' ? 'preserved' : previous));
  }, [open, eligibility.cleanupReason, selectionTouched]);

  // Derive the untouched default from current eligibility, rather than racing
  // asynchronous policy refreshes against another state update.
  const selectedFilesystemAction = primaryReason
    ? 'preserved'
    : !selectionTouched || (filesystemAction === 'cleaned' && eligibility.cleanupReason)
      ? eligibility.cleanupReason
        ? 'preserved'
        : 'cleaned'
      : filesystemAction;

  const actionReason =
    primaryReason ??
    (metadataAction === 'delete' || selectedFilesystemAction === 'deleted'
      ? eligibility.workspaceReason
      : selectedFilesystemAction === 'cleaned'
        ? eligibility.cleanupReason
        : eligibility.managementReason);
  const handleOk = () => {
    if (actionReason) return;
    onConfirm(
      metadataAction === 'delete'
        ? { metadataAction: 'delete', filesystemAction: 'deleted' }
        : { metadataAction: 'archive', filesystemAction: selectedFilesystemAction }
    );
  };

  // Determine button text and style based on metadata action
  const okText = metadataAction === 'archive' ? 'Archive Branch' : 'Delete Permanently';
  const okButtonProps = {
    danger: metadataAction === 'delete',
    disabled: !!actionReason || connectionDisabled || !!primaryAction,
  };

  return (
    <Modal
      title="Archive or Delete Branch"
      open={open}
      onOk={handleOk}
      onCancel={() => {
        if (!primaryAction) onCancel();
      }}
      closable={!primaryAction}
      keyboard={!primaryAction}
      maskClosable={!primaryAction}
      cancelButtonProps={{ disabled: !!primaryAction }}
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

        {teammate && (
          <Alert
            type="info"
            showIcon
            title="Retire a teammate without deleting its files"
            description={
              <Space orientation="vertical">
                <Text>
                  Any active teammate may be someone else's private primary. This dialog uses
                  explicit retirement for all active teammates because those preferences are not
                  visible to you. Retirement archives this teammate and its sessions, preserves all
                  files, and clears everyone's personal primary preference for it. It does not
                  choose a replacement.
                </Text>
                {eligibility.boardUnavailable && (
                  <Text>
                    Board details or permissions are unavailable; board controls are disabled.
                    Retirement still checks board-primary protection on the server. A board Editor
                    or Manager must clear or replace any board primary designation first.
                  </Text>
                )}
                {boardPrimary && (
                  <>
                    <Text>
                      First clear or replace this board's primary teammate. Nothing changes until
                      you confirm.
                    </Text>
                    <Space wrap>
                      {eligibility.canEditBoard && (
                        <Button
                          aria-label="Clear board primary"
                          disabled={boardActionDisabled}
                          loading={primaryAction === 'clear'}
                          onClick={() => {
                            setPrimaryError(undefined);
                            setConfirmPrimary('clear');
                          }}
                        >
                          Clear board primary
                        </Button>
                      )}
                      {!eligibility.boardUnavailable && (
                        <Typography.Link href={eligibility.board?.url}>
                          Open board to replace primary
                        </Typography.Link>
                      )}
                    </Space>
                    {!eligibility.canEditBoard && (
                      <Text>A board Editor or Manager must clear or replace the primary.</Text>
                    )}
                  </>
                )}
                {ownPrimary && (
                  <Text>
                    This is your personal primary teammate. Retirement clears that preference too.
                  </Text>
                )}
                {eligibility.managementReason && <Text>{eligibility.managementReason}</Text>}
                <Text>
                  For active teammates, Archive uses explicit retirement. Permanent deletion is
                  available after retirement.
                </Text>
                <Button
                  aria-label="Retire teammate — keep files"
                  danger
                  disabled={primaryDisabled || boardPrimary}
                  loading={primaryAction === 'retire'}
                  onClick={() => {
                    setPrimaryError(undefined);
                    setConfirmPrimary('retire');
                  }}
                >
                  Retire teammate — keep files
                </Button>
              </Space>
            }
          />
        )}

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
        {metadataAction === 'delete' && actionReason && (
          <Alert type="warning" showIcon title={actionReason} />
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
            disabled={metadataAction === 'delete' || !!eligibility.managementReason}
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
              <Radio value="cleaned" disabled={!!eligibility.cleanupReason || !!primaryReason}>
                <div>
                  <div>Clean — {eligibility.policy?.command || 'repository cleanup command'}</div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {eligibility.cleanupReason ||
                      'Runs the configured command. Files may be deleted; there is no undo.'}
                  </Text>
                </div>
              </Radio>
              <Radio value="deleted" disabled={!!eligibility.workspaceReason || !!primaryReason}>
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

        {metadataAction === 'archive' && eligibility.cleanupReason && (
          <Alert
            type="warning"
            showIcon
            title={
              !eligibility.workspaceReason &&
              eligibility.policy?.enabled === false &&
              selectedFilesystemAction === 'preserved'
                ? 'Cleanup is disabled for this repository. Archiving will keep workspace files on disk.'
                : eligibility.cleanupReason
            }
            description={
              canConfigure || eligibility.workspaceReason
                ? undefined
                : 'A repository administrator can configure branch cleanup.'
            }
            action={
              canConfigure &&
              eligibility.repo && (
                <Button
                  onClick={() => {
                    setSettingsRepo(eligibility.repo ?? null);
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
            disabled={!!eligibility.managementReason}
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
              <Radio value="delete" disabled={!!eligibility.workspaceReason}>
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
      <Modal
        destroyOnHidden
        open={confirmPrimary !== null}
        title={
          confirmPrimary === 'clear'
            ? 'Clear board primary teammate?'
            : 'Retire teammate and keep all files?'
        }
        okText={confirmPrimary === 'clear' ? 'Clear primary' : 'Retire teammate'}
        confirmLoading={!!primaryAction}
        okButtonProps={{
          'aria-label': confirmPrimary === 'clear' ? 'Clear primary' : 'Retire teammate',
          danger: confirmPrimary === 'retire',
          disabled:
            confirmPrimary === 'clear' ? boardActionDisabled : primaryDisabled || boardPrimary,
        }}
        cancelButtonProps={{ disabled: !!primaryAction }}
        closable={!primaryAction}
        keyboard={!primaryAction}
        maskClosable={!primaryAction}
        onCancel={() => {
          if (!primaryAction) setConfirmPrimary(null);
        }}
        onOk={() => confirmPrimary && runPrimaryAction(confirmPrimary)}
      >
        <p>
          {confirmPrimary === 'clear'
            ? 'The board will have no primary until you assign a replacement. The teammate stays active.'
            : 'Archives this teammate and its sessions and clears all personal primary preferences. All files stay intact. No replacement is selected.'}
        </p>
        {primaryError && (
          <div role="alert" aria-label="Teammate action failed">
            {primaryError}
          </div>
        )}
      </Modal>
      {client && currentUser && settingsRepo && canConfigure && settingsOpen && (
        <RepoCleanupSettingsModal
          client={client}
          user={currentUser}
          repo={settingsRepo}
          open={settingsOpen}
          onCancel={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false);
            eligibility.refresh();
          }}
        />
      )}
    </Modal>
  );
};
