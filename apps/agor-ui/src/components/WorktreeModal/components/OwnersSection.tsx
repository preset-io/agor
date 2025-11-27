/**
 * Owners Section Component
 *
 * Displays and manages worktree owners and permission settings.
 * Integrates with RBAC system for owner management and permission levels.
 *
 * @see context/explorations/rbac.md
 * @see context/explorations/unix-user-modes.md
 */

import type { AgorClient } from '@agor/core/api';
import type { User, Worktree, WorktreePermissionLevel } from '@agor/core/types';
import { UserOutlined } from '@ant-design/icons';
import { Button, Form, Select, Space, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useThemedMessage } from '../../../utils/message';

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
  const [selectedOwnerIds, setSelectedOwnerIds] = useState<string[]>([]);
  const [selectKey, setSelectKey] = useState(0); // Force re-render key
  const [othersCanValue, setOthersCanValue] = useState<WorktreePermissionLevel>(
    worktree.others_can || 'view'
  );
  const [othersFsAccessValue, setOthersFsAccessValue] = useState<'none' | 'read' | 'write'>(
    worktree.others_fs_access || 'read'
  );

  // Check if current user can edit owners
  // Only owners themselves OR users with admin/owner role can edit
  const currentUserId = currentUser?.user_id;
  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'owner';
  const isOwner = owners.some((o) => o.user_id === currentUserId);

  // While loading, assume admins can edit (we know their role immediately)
  // After loading, check ownership or admin status
  const canEdit = loading ? isAdmin : isAdmin || isOwner;

  // Load owners and all users
  // biome-ignore lint/correctness/useExhaustiveDependencies: showError causes infinite loop as it changes on every render
  useEffect(() => {
    if (!client) return;

    const loadData = async () => {
      try {
        setLoading(true);

        // Load owners
        const ownersResponse = await client.service('worktrees/:id/owners').find({
          route: { id: worktree.worktree_id },
        });
        const ownersData = ownersResponse as User[];
        setOwners(ownersData);
        setSelectedOwnerIds(ownersData.map((o) => o.user_id));

        // Load all users
        const usersResponse = await client.service('users').find({});
        const users = Array.isArray(usersResponse) ? usersResponse : usersResponse.data || [];
        setAllUsers(users);
      } catch (error) {
        console.error('Failed to load data:', error);
        showError('Failed to load owners');
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
    setOthersCanValue(worktree.others_can || 'view');
    setOthersFsAccessValue(worktree.others_fs_access || 'read');
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
    othersCanValue !== worktree.others_can || othersFsAccessValue !== worktree.others_fs_access;
  const hasUnsavedChanges = ownersChanged || permissionsChanged;

  const permissionLevelDescriptions = {
    view: 'Can view worktrees, sessions, tasks, and messages',
    prompt: 'View + can create tasks and messages (run agents)',
    all: 'Full access (create/update/delete sessions and worktrees)',
  };

  const fsAccessDescriptions = {
    none: 'No filesystem access (permission denied)',
    read: 'Read-only filesystem access',
    write: 'Read and write filesystem access',
  };

  return (
    <div>
      <Typography.Text strong style={{ fontSize: 14, display: 'block', marginBottom: 16 }}>
        Owners & Permissions
      </Typography.Text>

      {/* Owners Multi-Select */}
      <div style={{ marginBottom: 16 }}>
        <Typography.Text
          type="secondary"
          style={{ fontSize: 12, display: 'block', marginBottom: 8 }}
        >
          Owners (always have full access)
        </Typography.Text>
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
          options={allUsers.map((user) => {
            const isCurrentUser = user.user_id === currentUserId;
            const label = user.email || `User ${user.user_id.substring(0, 8)}`;
            const displayLabel = isCurrentUser ? `${label} (You)` : label;

            return {
              value: user.user_id,
              label: displayLabel,
            };
          })}
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
      </div>

      {/* Permission Settings */}
      <Form layout="horizontal" colon={false}>
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
              { value: 'view', label: 'View' },
              { value: 'prompt', label: 'Prompt' },
              { value: 'all', label: 'All' },
            ]}
          />
        </Form.Item>

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
