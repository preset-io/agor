/**
 * Owners Section Component
 *
 * Displays and manages worktree owners and permission settings.
 * Integrates with RBAC system for owner management and permission levels.
 *
 * @see context/explorations/rbac.md
 * @see context/explorations/unix-user-modes.md
 */

import type { AgorClient, User, Worktree, WorktreePermissionLevel } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { UserOutlined, WarningOutlined } from '@ant-design/icons';
import { Alert, Button, Form, Select, Space, Switch, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useThemedMessage } from '../../../utils/message';
import { Tag } from '../../Tag';

interface OwnersSectionProps {
  worktree: Worktree;
  client: AgorClient | null;
  currentUser?: User | null;
}

export const OwnersSection: React.FC<OwnersSectionProps> = ({ worktree, client, currentUser }) => {
  const { showSuccess, showError } = useThemedMessage();
  const [owners, setOwners] = useState<User[]>([]);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [rbacEnabled, setRbacEnabled] = useState(true); // Assume enabled until proven otherwise
  const [selectedOwnerIds, setSelectedOwnerIds] = useState<string[]>([]);
  const [selectKey, setSelectKey] = useState(0); // Force re-render key
  const [othersCanValue, setOthersCanValue] = useState<WorktreePermissionLevel>(
    worktree.others_can || 'session'
  );
  const [othersFsAccessValue, setOthersFsAccessValue] = useState<'none' | 'read' | 'write'>(
    worktree.others_fs_access || 'read'
  );
  const [allowSessionSharing, setAllowSessionSharing] = useState<boolean>(
    Boolean(worktree.dangerously_allow_session_sharing)
  );

  // Check if current user can edit owners
  // Owners can edit, AND admins have super powers (can edit any worktree)
  const currentUserId = currentUser?.user_id;
  const isAdmin = hasMinimumRole(currentUser?.role, ROLES.ADMIN);
  const isOwner = owners.some((o) => o.user_id === currentUserId);

  // Admins can always edit, regardless of loading state
  // After loading completes, worktree owners can also edit
  const canEdit = isAdmin || (!loading && isOwner);

  // Load owners and all users
  // biome-ignore lint/correctness/useExhaustiveDependencies: showError causes infinite loop as it changes on every render
  useEffect(() => {
    if (!client) return;

    const loadData = async () => {
      try {
        setLoading(true);

        // Load owners - if service doesn't exist (404), RBAC is disabled
        const ownersResponse = await client.service('worktrees/:id/owners').find({
          route: { id: worktree.worktree_id },
        });
        const ownersData = ownersResponse as User[];
        setOwners(ownersData);
        setSelectedOwnerIds(ownersData.map((o) => o.user_id));

        // Load all users
        const users = await client.service('users').findAll({});
        setAllUsers(users);
        setRbacEnabled(true); // If we got here, RBAC is enabled
        // biome-ignore lint/suspicious/noExplicitAny: Error type from API client is not strongly typed
      } catch (error: any) {
        // If service doesn't exist (404 or method not found), RBAC is disabled
        if (error?.code === 404 || error?.message?.includes('not found')) {
          setRbacEnabled(false);
        } else {
          console.error('Failed to load data:', error);
          showError('Failed to load owners');
        }
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [client, worktree.worktree_id]);

  const handleOwnersChange = (newOwnerIds: string[]) => {
    // Prevent removing all owners
    if (newOwnerIds.length === 0) {
      showError('At least one owner is required');
      // Force the Select to revert by resetting to actual owners and remounting
      const currentOwnerIds = owners.map((o) => o.user_id as string);
      setSelectedOwnerIds([...currentOwnerIds]);
      setSelectKey((prev) => prev + 1); // Force Select to remount
      return;
    }

    // Just update local state - don't save yet
    setSelectedOwnerIds(newOwnerIds);
  };

  const handleReset = () => {
    // Reset to original values
    const currentOwnerIds = owners.map((o) => o.user_id as string);
    setSelectedOwnerIds(currentOwnerIds);
    setOthersCanValue(worktree.others_can || 'session');
    setOthersFsAccessValue(worktree.others_fs_access || 'read');
    setAllowSessionSharing(Boolean(worktree.dangerously_allow_session_sharing));
    setSelectKey((prev) => prev + 1); // Force Select to remount
  };

  const handleSave = async () => {
    if (!client) return;

    const currentOwnerIds = owners.map((o) => o.user_id as string);
    const added = selectedOwnerIds.filter((id) => !currentOwnerIds.includes(id));
    const removed = currentOwnerIds.filter((id) => !selectedOwnerIds.includes(id));

    try {
      setLoading(true);

      // Add new owners
      for (const userId of added) {
        await client
          .service('worktrees/:id/owners')
          .create({ user_id: userId }, { route: { id: worktree.worktree_id } });
      }

      // Remove old owners
      for (const userId of removed) {
        await client.service('worktrees/:id/owners').remove(userId, {
          route: { id: worktree.worktree_id },
        });
      }

      // Update permissions
      await client.service('worktrees').patch(worktree.worktree_id, {
        others_can: othersCanValue,
        others_fs_access: othersFsAccessValue,
        dangerously_allow_session_sharing: allowSessionSharing,
      });

      // Reload owners to get fresh data
      const response = await client.service('worktrees/:id/owners').find({
        route: { id: worktree.worktree_id },
      });
      const ownersData = response as User[];
      setOwners(ownersData);
      setSelectedOwnerIds(ownersData.map((o) => o.user_id));

      const changes: string[] = [];
      if (added.length > 0 || removed.length > 0) {
        changes.push('owners');
      }
      if (
        othersCanValue !== worktree.others_can ||
        othersFsAccessValue !== worktree.others_fs_access
      ) {
        changes.push('permissions');
      }

      showSuccess(`Updated ${changes.join(' and ')} successfully`);
      // biome-ignore lint/suspicious/noExplicitAny: Error from API can be any
    } catch (error: any) {
      console.error('Failed to save changes:', error);
      showError(error.message || 'Failed to save changes');
    } finally {
      setLoading(false);
    }
  };

  // Check if there are unsaved changes
  const currentOwnerIds = owners.map((o) => o.user_id as string);
  const ownersChanged =
    selectedOwnerIds.length !== currentOwnerIds.length ||
    selectedOwnerIds.some((id) => !currentOwnerIds.includes(id));
  const permissionsChanged =
    othersCanValue !== worktree.others_can ||
    othersFsAccessValue !== worktree.others_fs_access ||
    allowSessionSharing !== Boolean(worktree.dangerously_allow_session_sharing);
  const hasUnsavedChanges = ownersChanged || permissionsChanged;

  const permissionLevelDescriptions: Record<WorktreePermissionLevel, string> = {
    none: 'No access (worktree is completely private to owners)',
    view: 'Can view worktrees, sessions, tasks, and messages',
    session: 'Can create new sessions (running as own identity) and prompt own sessions',
    prompt: 'Can prompt ANY session, including those created by other users',
    all: 'Full access (create/update/delete sessions and worktrees)',
  };

  const fsAccessDescriptions = {
    none: 'No filesystem access (permission denied)',
    read: 'Read-only filesystem access',
    write: 'Read and write filesystem access',
  };

  // If RBAC is disabled, don't render anything
  if (!rbacEnabled) {
    return null;
  }

  return (
    <div>
      <Typography.Text strong style={{ fontSize: 14, display: 'block', marginBottom: 16 }}>
        Owners & Permissions
      </Typography.Text>

      {/* All fields use consistent Form layout */}
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
            value={selectedOwnerIds}
            onChange={handleOwnersChange}
            loading={loading}
            disabled={!canEdit}
            showSearch
            filterOption={(input, option) =>
              (option?.label?.toString() || '').toLowerCase().includes(input.toLowerCase())
            }
            optionLabelProp="label"
            options={allUsers
              .map((user) => {
                const isCurrentUser = user.user_id === currentUserId;
                const label = user.email || `User ${user.user_id.substring(0, 8)}`;
                const displayLabel = isCurrentUser ? `${label} (You)` : label;

                return {
                  value: user.user_id,
                  label: displayLabel,
                };
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

        {/* Permission Settings */}
        <Form.Item
          label="Others Can"
          labelCol={{ span: 8 }}
          wrapperCol={{ span: 16 }}
          help={permissionLevelDescriptions[othersCanValue]}
          style={{ marginBottom: 12 }}
        >
          <Select
            value={othersCanValue}
            onChange={setOthersCanValue}
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

        {othersCanValue === 'prompt' && (
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

        <Form.Item
          label="Filesystem Access"
          labelCol={{ span: 8 }}
          wrapperCol={{ span: 16 }}
          help={fsAccessDescriptions[othersFsAccessValue]}
          style={{ marginBottom: 12 }}
        >
          <Select
            value={othersFsAccessValue}
            onChange={setOthersFsAccessValue}
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
            checked={allowSessionSharing}
            onChange={setAllowSessionSharing}
            disabled={!canEdit}
          />
        </Form.Item>

        {allowSessionSharing && (
          <Form.Item wrapperCol={{ offset: 8, span: 16 }} style={{ marginBottom: 12 }}>
            <Alert
              type="error"
              showIcon
              icon={<WarningOutlined />}
              message="Dangerous: identity borrowing on spawn/fork"
              description="With this enabled, sessions spawned or forked by other users in this worktree run under the original creator's OS identity, credentials, and environment variables. A collaborator can effectively execute code as you. Only enable for fully trusted collaborators or legacy automation that depends on the old behavior."
            />
          </Form.Item>
        )}

        {hasUnsavedChanges && (
          <Form.Item wrapperCol={{ offset: 8, span: 16 }}>
            <Space>
              <Button
                type="primary"
                size="small"
                onClick={handleSave}
                loading={loading}
                disabled={!canEdit}
              >
                Save Changes
              </Button>
              <Button size="small" onClick={handleReset} disabled={loading}>
                Reset
              </Button>
            </Space>
          </Form.Item>
        )}
      </Form>
    </div>
  );
};
