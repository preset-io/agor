/**
 * Permissions Tab — owners + RBAC controls for a branch.
 *
 * Controlled by `useBranchModalForm`: state lives in the parent modal so the
 * Save action at the modal footer commits owners, permission tiers, and other
 * branch fields in one shot.
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import type { BranchPermissionLevel, Group, User } from '@agor-live/client';
import { shortId } from '@agor-live/client';
import { UserOutlined, WarningOutlined } from '@ant-design/icons';
import { Alert, Form, Select, Space, Switch, Typography } from 'antd';
import { useState } from 'react';
import { useThemedMessage } from '../../../utils/message';
import { Tag } from '../../Tag';
import type { FsAccessLevel, PermissionsFormState } from '../useBranchModalForm';

// Note: this tab is only rendered when RBAC is enabled — the parent
// `BranchModal` hides it otherwise. No in-tab `rbacEnabled=false` placeholder
// is needed (or reachable).
interface PermissionsTabProps {
  loadingOwners: boolean;
  canEdit: boolean;
  allUsers: User[];
  allGroups: Group[];
  currentUser?: User | null;
  state: PermissionsFormState;
  setField: <K extends keyof PermissionsFormState>(key: K, value: PermissionsFormState[K]) => void;
  /** Non-fatal owners-load failure (network / server error, not 404). */
  ownersLoadError?: Error | null;
}

const permissionLevelDescriptions: Record<BranchPermissionLevel, string> = {
  none: 'No access (branch is completely private to owners)',
  view: 'Can view branches, sessions, tasks, and messages',
  session: 'Can create new sessions (running as own identity) and prompt own sessions',
  prompt: 'Can prompt ANY session, including those created by other users',
  all: 'Full access (create/update/delete sessions and branches)',
};

const fsAccessDescriptions: Record<FsAccessLevel, string> = {
  none: 'No filesystem access (permission denied)',
  read: 'Read-only filesystem access',
  write: 'Read and write filesystem access',
};

export const PermissionsTab: React.FC<PermissionsTabProps> = ({
  loadingOwners,
  canEdit,
  allUsers,
  allGroups = [],
  currentUser,
  state,
  setField,
  ownersLoadError,
}) => {
  const { showError } = useThemedMessage();
  // Local key to force the Select to remount when we need to reject a removal
  // (Ant's Select is uncontrolled enough that pasting the previous value back
  // doesn't always cancel an in-flight tag removal animation).
  const [selectKey, setSelectKey] = useState(0);

  const currentUserId = currentUser?.user_id;
  const groupGrants = state.groupGrants ?? [];

  const handleOwnersChange = (newOwnerIds: string[]) => {
    if (newOwnerIds.length === 0) {
      showError('At least one owner is required');
      // Force remount to revert the visual removal animation
      setSelectKey((prev) => prev + 1);
      return;
    }
    setField('selectedOwnerIds', newOwnerIds);
  };

  return (
    <div style={{ width: '100%', maxHeight: '70vh', overflowY: 'auto', padding: 24 }}>
      <Typography.Text strong style={{ fontSize: 14, display: 'block', marginBottom: 16 }}>
        Owners & Permissions
      </Typography.Text>

      {ownersLoadError && (
        <Alert
          type="error"
          showIcon
          message="Could not load branch permissions"
          description={`${ownersLoadError.message}. Editing is disabled until this resolves — try closing and reopening the modal.`}
          style={{ marginBottom: 16 }}
        />
      )}

      <Form layout="horizontal" colon={false}>
        {/* Owners Multi-Select */}
        <Form.Item
          label="Owners"
          labelCol={{ span: 8 }}
          wrapperCol={{ span: 16 }}
          help="Owners always have full access"
          style={{ marginBottom: 12 }}
        >
          <Select
            key={selectKey}
            mode="multiple"
            style={{ width: '100%' }}
            placeholder="Select owners..."
            value={state.selectedOwnerIds}
            onChange={handleOwnersChange}
            loading={loadingOwners}
            disabled={!canEdit}
            showSearch
            filterOption={(input, option) =>
              (option?.label?.toString() || '').toLowerCase().includes(input.toLowerCase())
            }
            optionLabelProp="label"
            options={allUsers
              .map((user) => {
                const isCurrentUser = user.user_id === currentUserId;
                const label = user.email || `User ${shortId(user.user_id)}`;
                const displayLabel = isCurrentUser ? `${label} (You)` : label;
                return { value: user.user_id, label: displayLabel };
              })
              .sort((a, b) => a.label.localeCompare(b.label))}
            tagRender={(props) => {
              const user = allUsers.find((u) => u.user_id === props.value);
              const isCurrentUser = user?.user_id === currentUserId;
              return (
                <Tag
                  {...props}
                  color={isCurrentUser ? 'green' : 'default'}
                  closable={props.closable}
                  onClose={props.onClose}
                  style={{ marginRight: 3 }}
                >
                  <Space size={4}>
                    <UserOutlined style={{ fontSize: 11 }} />
                    <span>{props.label}</span>
                  </Space>
                </Tag>
              );
            }}
          />
        </Form.Item>

        {/* Group Grants */}
        <Form.Item
          label="Groups"
          labelCol={{ span: 8 }}
          wrapperCol={{ span: 16 }}
          help="Grant explicit branch access to user groups"
          style={{ marginBottom: 12 }}
        >
          <Space direction="vertical" style={{ width: '100%' }}>
            <Select
              mode="multiple"
              style={{ width: '100%' }}
              placeholder="Select groups..."
              value={groupGrants.map((grant) => grant.group_id)}
              disabled={!canEdit}
              options={allGroups
                .map((group) => ({ value: group.group_id, label: group.name }))
                .sort((a, b) => a.label.localeCompare(b.label))}
              onChange={(groupIds) => {
                const existing = new Map(groupGrants.map((grant) => [grant.group_id, grant]));
                setField(
                  'groupGrants',
                  groupIds.map(
                    (groupId) => existing.get(groupId) || { group_id: groupId, can: 'view' }
                  )
                );
              }}
            />
            {groupGrants.map((grant) => {
              const group = allGroups.find((g) => g.group_id === grant.group_id);
              return (
                <Space
                  key={grant.group_id}
                  style={{ width: '100%', justifyContent: 'space-between' }}
                >
                  <Typography.Text>{group?.name || grant.group_id}</Typography.Text>
                  <Select
                    size="small"
                    style={{ width: 140 }}
                    value={grant.can}
                    disabled={!canEdit}
                    options={[
                      { value: 'view', label: 'View' },
                      { value: 'session', label: 'Own Sessions' },
                      { value: 'prompt', label: 'Prompt' },
                      { value: 'all', label: 'All' },
                    ]}
                    onChange={(can) =>
                      setField(
                        'groupGrants',
                        groupGrants.map((g) => (g.group_id === grant.group_id ? { ...g, can } : g))
                      )
                    }
                  />
                </Space>
              );
            })}
          </Space>
        </Form.Item>

        {/* Permission Tier */}
        <Form.Item
          label="Others Can"
          labelCol={{ span: 8 }}
          wrapperCol={{ span: 16 }}
          help={permissionLevelDescriptions[state.othersCan]}
          style={{ marginBottom: 12 }}
        >
          <Select
            value={state.othersCan}
            onChange={(value) => setField('othersCan', value)}
            disabled={!canEdit}
            options={[
              { value: 'none', label: 'None' },
              { value: 'view', label: 'View' },
              { value: 'session', label: 'Own Sessions' },
              { value: 'prompt', label: 'Prompt' },
              { value: 'all', label: 'All' },
            ]}
          />
        </Form.Item>

        {state.othersCan === 'prompt' && (
          <Form.Item wrapperCol={{ offset: 8, span: 16 }} style={{ marginBottom: 12 }}>
            <Alert
              type="warning"
              showIcon
              icon={<WarningOutlined />}
              message="Unix identity risk"
              description="Allows users to send prompts to sessions they didn't create. Those sessions execute under the original creator's OS identity and filesystem permissions. Only use with fully trusted collaborators."
            />
          </Form.Item>
        )}

        {/* Filesystem Access */}
        <Form.Item
          label="Filesystem Access"
          labelCol={{ span: 8 }}
          wrapperCol={{ span: 16 }}
          help={fsAccessDescriptions[state.othersFsAccess]}
          style={{ marginBottom: 12 }}
        >
          <Select
            value={state.othersFsAccess}
            onChange={(value) => setField('othersFsAccess', value)}
            disabled={!canEdit}
            options={[
              { value: 'none', label: 'None' },
              { value: 'read', label: 'Read' },
              { value: 'write', label: 'Write' },
            ]}
          />
        </Form.Item>

        {/*
         * TODO(product): finalize copy for "Allow legacy session sharing" — the
         * label/help/warning text below is provisional. Coordinate wording with
         * docs + UI.
         */}
        <Form.Item
          label="Allow legacy session sharing"
          labelCol={{ span: 8 }}
          wrapperCol={{ span: 16 }}
          help="When OFF (default), spawning or forking another user's session attributes the new session to YOU. When ON, the new session keeps the original creator's identity, credentials, and Unix user — restoring legacy behavior."
          style={{ marginBottom: 12 }}
        >
          <Switch
            checked={state.allowSessionSharing}
            onChange={(value) => setField('allowSessionSharing', value)}
            disabled={!canEdit}
          />
        </Form.Item>

        {state.allowSessionSharing && (
          <Form.Item wrapperCol={{ offset: 8, span: 16 }} style={{ marginBottom: 12 }}>
            <Alert
              type="error"
              showIcon
              icon={<WarningOutlined />}
              message="Dangerous: identity borrowing on spawn/fork"
              description="With this enabled, sessions spawned or forked by other users in this branch run under the original creator's OS identity, credentials, and environment variables. A collaborator can effectively execute code as you. Only enable for fully trusted collaborators or legacy automation that depends on the old behavior."
            />
          </Form.Item>
        )}
      </Form>
    </div>
  );
};
