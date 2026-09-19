import type { AgorClient, OwnershipTransferResult, User, UserID } from '@agor-live/client';
import { hasMinimumRole, OWNERSHIP_TRANSFER_SERVICES, ROLES } from '@agor-live/client';
import { EditOutlined } from '@ant-design/icons';
import { Alert, Button, Flex, Modal, Select, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { useThemedMessage } from '@/utils/message';

interface OwnershipTransferProps {
  kind: 'board' | 'branch';
  resourceId: string;
  ownerUserId: UserID;
  currentUser?: User | null;
  users: User[];
  client: AgorClient | null;
  disabled?: boolean;
  onTransferred: () => void;
}

/** A separate command, never a primary-owner edit inside a policy draft. */
export function OwnershipTransfer({
  kind,
  resourceId,
  ownerUserId,
  currentUser,
  users,
  client,
  disabled,
  onTransferred,
}: OwnershipTransferProps) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<UserID>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<OwnershipTransferResult>();
  const { showSuccess } = useThemedMessage();
  const allowed = Boolean(
    currentUser &&
      (currentUser.user_id === ownerUserId || hasMinimumRole(currentUser.role, ROLES.ADMIN))
  );
  if (!allowed) return null;
  const candidates = users.filter(
    (user) => user.user_id !== ownerUserId && hasMinimumRole(user.role, ROLES.MEMBER)
  );
  const finish = () => {
    if (busy) return;
    setOpen(false);
    if (result) onTransferred();
  };
  const transfer = async () => {
    if (!client || !target || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const saved = await client.service(OWNERSHIP_TRANSFER_SERVICES[kind]).patch(
        null,
        {
          expected_owner_user_id: ownerUserId,
          target_user_id: target,
        },
        { route: { id: resourceId } }
      );
      setResult(saved);
      showSuccess('Management ownership transferred');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Ownership transfer failed. Reload the resource before trying again.'
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Tooltip title="Transfer ownership">
        <Button
          type="text"
          size="small"
          style={{ flexShrink: 0 }}
          icon={<EditOutlined />}
          aria-label="Transfer ownership"
          disabled={disabled || !client}
          onClick={() => {
            setOpen(true);
            setTarget(undefined);
            setError(undefined);
            setResult(undefined);
          }}
        />
      </Tooltip>
      <Modal
        title={`Transfer ${kind} ownership`}
        open={open}
        onCancel={finish}
        keyboard={!busy}
        closable={!busy}
        maskClosable={!busy}
        onOk={result ? finish : () => void transfer()}
        okText={result ? 'Done' : 'Transfer ownership'}
        confirmLoading={busy}
        okButtonProps={{ disabled: !result && !target, danger: !result }}
        cancelButtonProps={{ disabled: busy, style: result ? { display: 'none' } : undefined }}
      >
        <Flex vertical gap="middle">
          <Alert
            type="warning"
            showIcon
            description={`Only management ownership of this ${kind} changes. Related boards/branches, historical authorship, access entries, sessions, schedules, gateway run-as, memory ownership and credentials do not transfer. Existing work is not paused or reassigned. Unsaved settings in the underlying editor will be discarded when this completes.`}
          />
          {result ? (
            <Alert
              type="success"
              showIcon
              description={
                <>
                  <Typography.Paragraph>
                    Management ownership transferred. The previous owner’s remaining resource-policy
                    capabilities are:{' '}
                    {result.previous_owner_access.capabilities.join(', ') || 'none'}.
                  </Typography.Paragraph>
                  <Typography.Text>
                    {kind === 'branch' && (
                      <>Branch file access: {result.previous_owner_access.fs_access}. </>
                    )}
                    Independent administrator privileges are unchanged. This does not revoke the
                    previous owner’s account or credentials. Reopen settings to load current
                    authority.
                  </Typography.Text>
                </>
              }
            />
          ) : (
            <Select
              aria-label="Successor owner"
              placeholder="Choose a workspace member"
              showSearch
              optionFilterProp="label"
              value={target}
              disabled={busy}
              onChange={setTarget}
              options={candidates.map((user) => ({
                value: user.user_id,
                label: user.name || user.email,
              }))}
            />
          )}
          {error && <Alert type="error" showIcon description={error} />}
        </Flex>
      </Modal>
    </>
  );
}
