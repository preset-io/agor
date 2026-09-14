import { AgorUserLifecycleAuthority } from '@agor/core/config/browser';
import { EXECUTION_HOME_KEY_PATTERN } from '@agor/core/types';
import type {
  AgorClient,
  CreateUserInput,
  GatewayChannel,
  Group,
  GroupMembership,
  UpdateUserInput,
  User,
} from '@agor-live/client';
import {
  canAssignUserRole,
  hasMinimumRole,
  hasRoleAuthorityOver,
  ROLE_OPTIONS,
  ROLES,
} from '@agor-live/client';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Button,
  Checkbox,
  Form,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { mapToSortedArray } from '@/utils/mapHelpers';
import {
  passwordPolicyHelp,
  passwordPolicyRequirements,
  passwordRules,
} from '@/utils/passwordPolicy';
import { filterBySettingsSearch } from '@/utils/settingsSearch';
import { isIdentityCapabilityAvailable, useAuthConfig } from '../../hooks/useAuthConfig';
import {
  useAuthenticatedAuthorityScope,
  useAuthorityOperationGuard,
} from '../../hooks/useAuthorityOperationGuard';
import { useThemedMessage } from '../../utils/message';
import { HighlightMatch } from '../HighlightMatch';
import { UserIdentityAvatar } from '../UserIdentityAvatar';
import { AdaptiveSettingsModal } from './AdaptiveSettingsModal';
import { ResponsiveSettingsHeader } from './ResponsiveSettingsHeader';
import { SettingsActionGroup } from './SettingsActionGroup';
import { UserAvatarsTab } from './UserAvatarsTab';
import { UserSettingsModal } from './UserSettingsModal';

interface UsersTableProps {
  userById: Map<string, User>;
  gatewayChannelById?: Map<string, GatewayChannel>;
  client: AgorClient | null;
  currentUser?: User | null;
  onCreate?: (data: CreateUserInput, shouldApply?: () => boolean) => void | Promise<void>;
  onUpdate?: (
    userId: string,
    updates: UpdateUserInput,
    shouldApply?: () => boolean
  ) => void | Promise<void>;
  onDelete?: (userId: string, shouldApply?: () => boolean) => void | Promise<void>;
}

export const UsersTable: React.FC<UsersTableProps> = ({
  userById,
  gatewayChannelById = new Map(),
  client,
  currentUser,
  onCreate,
  onUpdate,
  onDelete,
}) => {
  const { showError } = useThemedMessage();
  const { config: authConfig, identityContractState } = useAuthConfig();
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [memberships, setMemberships] = useState<GroupMembership[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [form] = Form.useForm();
  const isAdmin = hasMinimumRole(currentUser?.role, ROLES.ADMIN);
  const callerAuthority = useAuthenticatedAuthorityScope(
    client,
    currentUser ? `${currentUser.user_id}:${currentUser.role}` : null
  );
  const operationGuard = useAuthorityOperationGuard(callerAuthority.operationScope);

  // biome-ignore lint/correctness/useExhaustiveDependencies: authenticated identity and role intentionally erase password-bearing forms
  useLayoutEffect(() => {
    form.resetFields();
    setCreateModalOpen(false);
    setEditingUser(null);
  }, [currentUser?.role, currentUser?.user_id, form]);
  const externallyManaged =
    authConfig?.identity?.userLifecycle === AgorUserLifecycleAuthority.EXTERNAL;
  const canCreateUsers =
    isAdmin && isIdentityCapabilityAvailable(authConfig, identityContractState, 'create');
  const canDeleteUsers = isIdentityCapabilityAvailable(authConfig, identityContractState, 'delete');
  const passwordRequirements = passwordPolicyRequirements(authConfig?.passwordPolicy);
  const canManageAvatarSettings =
    isAdmin &&
    isIdentityCapabilityAvailable(authConfig, identityContractState, 'avatarSettingsWrite');
  const assignableRoleOptions = ROLE_OPTIONS.filter((option) =>
    canAssignUserRole(currentUser?.role, option.value)
  );

  const canEditUser = (target: User): boolean =>
    currentUser?.user_id === target.user_id ||
    (isAdmin && hasRoleAuthorityOver(currentUser?.role, target.role));

  const canDeleteUser = (target: User): boolean =>
    !!currentUser &&
    currentUser.user_id !== target.user_id &&
    isAdmin &&
    canDeleteUsers &&
    hasRoleAuthorityOver(currentUser.role, target.role);

  const loadGroups = useCallback(async () => {
    const operation = operationGuard.begin();
    if (!client || !isAdmin) {
      setGroups([]);
      setMemberships([]);
      return;
    }
    try {
      const [nextGroups, nextMemberships] = await Promise.all([
        client.service('groups').findAll({ query: { archived: false } }),
        client.service('group-memberships').findAll({}),
      ]);
      if (!operation.isCurrent()) return;
      setGroups(nextGroups as Group[]);
      setMemberships(nextMemberships as GroupMembership[]);
    } catch (error) {
      if (!operation.isCurrent()) return;
      showError(
        `Failed to load user groups: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }, [client, isAdmin, operationGuard, showError]);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  const groupsByUser = useMemo(() => {
    const map = new Map<string, Group['group_id'][]>();
    for (const membership of memberships) {
      const ids = map.get(membership.user_id) || [];
      ids.push(membership.group_id);
      map.set(membership.user_id, ids);
    }
    return map;
  }, [memberships]);

  const groupById = useMemo(
    () => new Map(groups.map((group) => [group.group_id, group])),
    [groups]
  );

  const users = useMemo(() => {
    const sorted = mapToSortedArray(userById, (a, b) =>
      a.email.localeCompare(b.email, undefined, { sensitivity: 'base' })
    );
    return filterBySettingsSearch(sorted, searchTerm, [
      (user) => user.email,
      (user) => user.name,
      (user) => user.unix_username,
      (user) => user.role,
      (user) =>
        (groupsByUser.get(user.user_id) || [])
          .map((groupId) => groupById.get(groupId))
          .filter((group): group is Group => Boolean(group))
          .flatMap((group) => [group.name, group.slug]),
    ]);
  }, [userById, searchTerm, groupsByUser, groupById]);

  const handleDelete = (userId: string) => {
    const operation = operationGuard.begin();
    if (!operation.isCurrent()) return;
    onDelete?.(userId, operation.isCurrent);
  };

  const handleCreate = async () => {
    const operation = operationGuard.begin();
    if (!operation.isCurrent()) return;
    try {
      const values = await form.validateFields();
      if (!operation.isCurrent()) return;
      await onCreate?.(
        {
          email: values.email,
          password: values.password,
          name: values.name,
          role: values.role || ROLES.MEMBER,
          unix_username: values.unix_username,
          must_change_password: values.must_change_password || false,
        },
        operation.isCurrent
      );
      if (!operation.isCurrent()) return;
      form.resetFields();
      setCreateModalOpen(false);
    } catch (error) {
      if (!operation.isCurrent()) return;
      const code = (error as { data?: { code?: unknown } } | undefined)?.data?.code;
      if (typeof code === 'string' && code.startsWith('PASSWORD_')) {
        form.setFields([
          {
            name: 'password',
            errors: [error instanceof Error ? error.message : 'Password was rejected'],
          },
        ]);
      }
      // Client-side validation already renders field errors. Server failures
      // are toasted by the owning handler; keep the modal and values intact.
    }
  };

  const getRoleColor = (role: User['role']) => {
    switch (role) {
      case 'superadmin':
        return 'purple';
      case 'admin':
        return 'red';
      case 'member':
        return 'blue';
      case 'viewer':
        return 'default';
      default:
        return 'default';
    }
  };

  const columns = [
    {
      title: 'User',
      dataIndex: 'email',
      key: 'email',
      render: (email: string, user: User) => (
        <Space>
          <UserIdentityAvatar user={user} size={28} fontSize="20px" />
          <span>
            <HighlightMatch text={email} query={searchTerm} />
          </span>
        </Space>
      ),
    },
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => (
        <Typography.Text>
          {name ? <HighlightMatch text={name} query={searchTerm} /> : '—'}
        </Typography.Text>
      ),
    },
    {
      title: 'Role',
      dataIndex: 'role',
      key: 'role',
      width: 120,
      render: (role: User['role']) => <Tag color={getRoleColor(role)}>{role.toUpperCase()}</Tag>,
    },
    {
      title: 'Groups',
      key: 'groups',
      width: 280,
      render: (_: unknown, user: User) => {
        const userGroupIds = groupsByUser.get(user.user_id) || [];
        if (userGroupIds.length === 0) {
          return <Typography.Text type="secondary">—</Typography.Text>;
        }

        return (
          <Space size={[4, 4]} wrap>
            {userGroupIds
              .map((groupId) => groupById.get(groupId))
              .filter((group): group is Group => Boolean(group))
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((group) => (
                <Tag key={group.group_id}>
                  <HighlightMatch text={group.name} query={searchTerm} />
                </Tag>
              ))}
          </Space>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 88,
      render: (_: unknown, user: User) => {
        const showEdit = canEditUser(user);
        const showDelete = canDeleteUser(user);
        if (!showEdit && !showDelete) return null;
        return (
          <SettingsActionGroup>
            {showEdit && (
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                aria-label={`Edit ${user.email}`}
                onClick={() => setEditingUser(user)}
              />
            )}
            {showDelete && (
              <Popconfirm
                title="Delete user?"
                description={`Are you sure you want to delete user "${user.email}"?`}
                onConfirm={() => handleDelete(user.user_id)}
                okText="Delete"
                cancelText="Cancel"
                okButtonProps={{ danger: true }}
              >
                <Button
                  type="text"
                  size="small"
                  icon={<DeleteOutlined />}
                  aria-label={`Delete ${user.email}`}
                  danger
                />
              </Popconfirm>
            )}
          </SettingsActionGroup>
        );
      },
    },
  ];

  const usersTable = (
    <div>
      <ResponsiveSettingsHeader
        description={
          externallyManaged
            ? 'User accounts and roles are managed by your identity provider.'
            : 'Manage user accounts and permissions.'
        }
        actions={(compact) => (
          <Space wrap style={{ width: compact ? '100%' : undefined }}>
            <Input
              allowClear
              placeholder="Search name, email, username, role, or groups"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              style={{ width: compact ? '100%' : 320, flex: compact ? '1 1 100%' : undefined }}
            />
            {canCreateUsers && (
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => setCreateModalOpen(true)}
              >
                New User
              </Button>
            )}
          </Space>
        )}
      />

      <Table
        dataSource={users}
        columns={columns}
        rowKey="user_id"
        pagination={false}
        size="small"
        scroll={{ x: 900 }}
      />

      {/* Create User Modal */}
      {canCreateUsers && (
        <AdaptiveSettingsModal
          title="Create User"
          open={createModalOpen}
          onOk={handleCreate}
          onCancel={() => {
            form.resetFields();
            setCreateModalOpen(false);
          }}
          okText="Create"
          width={800}
        >
          <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
            <Form.Item label="Name" name="name" style={{ marginBottom: 24 }}>
              <Input placeholder="John Doe" />
            </Form.Item>

            <Form.Item
              label="Email"
              name="email"
              rules={[
                { required: true, message: 'Please enter an email' },
                { type: 'email', message: 'Please enter a valid email' },
              ]}
            >
              <Input placeholder="user@example.com" />
            </Form.Item>

            <Form.Item
              label="Execution Home Key"
              name="unix_username"
              help="Optional transitional home key for delegated execution"
              rules={[
                {
                  pattern: EXECUTION_HOME_KEY_PATTERN,
                  message:
                    'Start with a lowercase letter or underscore; then use lowercase letters, numbers, hyphens, or underscores',
                },
                { max: 32, message: 'Execution home key must be 32 characters or less' },
              ]}
            >
              <Input placeholder="johnsmith" maxLength={32} />
            </Form.Item>

            <Form.Item
              label="Password"
              name="password"
              extra={passwordPolicyHelp(passwordRequirements)}
              rules={passwordRules(passwordRequirements, { required: true })}
            >
              <Input.Password placeholder="••••••••" autoComplete="new-password" />
            </Form.Item>

            <Form.Item
              label="Role"
              name="role"
              initialValue={ROLES.MEMBER}
              rules={[{ required: true, message: 'Please select a role' }]}
            >
              <Select
                options={assignableRoleOptions.map((opt) => ({
                  value: opt.value,
                  label: opt.label,
                  title: opt.description,
                }))}
              />
            </Form.Item>

            <Form.Item name="must_change_password" valuePropName="checked" initialValue={false}>
              <Checkbox>Force password change on first login</Checkbox>
            </Form.Item>
          </Form>
        </AdaptiveSettingsModal>
      )}

      {/* Edit User Modal - reuses UserSettingsModal */}
      <UserSettingsModal
        open={!!editingUser}
        onClose={() => {
          setEditingUser(null);
          void loadGroups();
        }}
        user={editingUser}
        client={client}
        currentUser={currentUser}
        onUpdate={onUpdate}
      />
    </div>
  );

  return (
    <Tabs
      defaultActiveKey="users"
      items={[
        { key: 'users', label: 'Users', children: usersTable },
        ...(canManageAvatarSettings
          ? [
              {
                key: 'avatars',
                label: 'Avatars',
                children: (
                  <UserAvatarsTab
                    client={client}
                    gatewayChannelById={gatewayChannelById}
                    identityKey={callerAuthority.identityKey}
                    operationScope={callerAuthority.operationScope}
                  />
                ),
              },
            ]
          : []),
      ]}
    />
  );
};
