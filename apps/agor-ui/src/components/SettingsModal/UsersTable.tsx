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
import { hasMinimumRole, ROLE_OPTIONS, ROLES } from '@agor-live/client';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Button,
  Checkbox,
  Flex,
  Form,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { type Key, useCallback, useEffect, useMemo, useState } from 'react';
import { mapToSortedArray } from '@/utils/mapHelpers';
import { filterBySettingsSearch } from '@/utils/settingsSearch';
import { useThemedMessage } from '../../utils/message';
import { FormEmojiPickerInput } from '../EmojiPickerInput';
import { HighlightMatch } from '../HighlightMatch';
import { UserIdentityAvatar } from '../UserIdentityAvatar';
import { ListPanelHeader } from './panelPrimitives';
import { SettingsActionGroup } from './SettingsActionGroup';
import { DrillInFrame, useSettingsDrill } from './SettingsDrill';
import { UserAvatarsTab } from './UserAvatarsTab';
import { UserSettingsModal } from './UserSettingsModal';

interface UsersTableProps {
  userById: Map<string, User>;
  gatewayChannelById?: Map<string, GatewayChannel>;
  client: AgorClient | null;
  currentUser?: User | null;
  onCreate?: (data: CreateUserInput) => void;
  onUpdate?: (userId: string, updates: UpdateUserInput) => void;
  onDelete?: (userId: string) => void;
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
  const { drill, openDrill, closeDrill } = useSettingsDrill();
  const [groups, setGroups] = useState<Group[]>([]);
  const [memberships, setMemberships] = useState<GroupMembership[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [createDirty, setCreateDirty] = useState(false);
  const [form] = Form.useForm();
  const isAdmin = hasMinimumRole(currentUser?.role, ROLES.ADMIN);

  // Editing / creating swaps this section's Content pane for a drill-in instead
  // of stacking a second modal (Edit previously popped the whole UserSettingsModal
  // on top of Workspace Settings).
  const editingUser =
    drill?.kind === 'users' && drill.mode === 'edit' && drill.recordId
      ? (userById.get(drill.recordId) ?? null)
      : null;
  const isCreating = drill?.kind === 'users' && drill.mode === 'create';

  const openEdit = useCallback(
    (user: User) => openDrill({ kind: 'users', mode: 'edit', recordId: user.user_id }),
    [openDrill]
  );
  const openCreate = useCallback(() => openDrill({ kind: 'users', mode: 'create' }), [openDrill]);

  // Reset the create form each time the create drill-in opens.
  useEffect(() => {
    if (isCreating) {
      form.resetFields();
      setCreateDirty(false);
    }
  }, [isCreating, form]);

  const loadGroups = useCallback(async () => {
    if (!client || !isAdmin) {
      setGroups([]);
      setMemberships([]);
      return;
    }
    const [nextGroups, nextMemberships] = await Promise.all([
      client.service('groups').findAll({ query: { archived: false } }),
      client.service('group-memberships').findAll({}),
    ]);
    setGroups(nextGroups as Group[]);
    setMemberships(nextMemberships as GroupMembership[]);
  }, [client, isAdmin]);

  useEffect(() => {
    loadGroups().catch((error) =>
      showError(
        `Failed to load user groups: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }, [loadGroups, showError]);

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
    onDelete?.(userId);
  };

  const handleCreate = () => {
    form
      .validateFields()
      .then((values) => {
        onCreate?.({
          email: values.email,
          password: values.password,
          name: values.name,
          emoji: values.emoji || '👤',
          role: values.role || ROLES.MEMBER,
          unix_username: values.unix_username,
          must_change_password: values.must_change_password || false,
        });
        form.resetFields();
        setCreateDirty(false);
        closeDrill();
      })
      .catch(() => {
        // Form validation failed - Ant Design will show field errors automatically
      });
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
          <Typography.Link ellipsis title={email} onClick={() => openEdit(user)}>
            <HighlightMatch text={email} query={searchTerm} />
          </Typography.Link>
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
      // Native funnel filter for the fixed role set, alongside the free-text search.
      filters: ROLE_OPTIONS.map((opt) => ({ text: opt.label, value: opt.value })),
      onFilter: (value: Key | boolean, user: User) => user.role === value,
      render: (role: User['role']) => <Tag color={getRoleColor(role)}>{role.toUpperCase()}</Tag>,
    },
    {
      title: 'Groups',
      key: 'groups',
      width: 280,
      // One entry per group in the workspace; a user matches if they belong to it.
      filters: groups
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((group) => ({ text: group.name, value: group.group_id })),
      onFilter: (value: Key | boolean, user: User) =>
        (groupsByUser.get(user.user_id) || []).includes(value as Group['group_id']),
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
      render: (_: unknown, user: User) => (
        <SettingsActionGroup>
          <Tooltip title="Edit user">
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={() => openEdit(user)}
            />
          </Tooltip>
          <Popconfirm
            title="Delete user?"
            description={`Are you sure you want to delete user "${user.email}"?`}
            onConfirm={() => handleDelete(user.user_id)}
            okText="Delete"
            cancelText="Cancel"
            okButtonProps={{ danger: true }}
          >
            <Button type="text" size="small" icon={<DeleteOutlined />} danger />
          </Popconfirm>
        </SettingsActionGroup>
      ),
    },
  ];

  const usersTable = (
    <div>
      <ListPanelHeader
        title="Users"
        description="Manage user accounts and permissions."
        search={
          <Input
            allowClear
            placeholder="Search name, email, username, role, or groups"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            style={{ width: 320 }}
          />
        }
        actions={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            New User
          </Button>
        }
      />

      <Table
        dataSource={users}
        columns={columns}
        rowKey="user_id"
        pagination={false}
        size="small"
      />
    </div>
  );

  const createFields = (
    <Form
      form={form}
      layout="vertical"
      style={{ maxWidth: 520 }}
      onValuesChange={() => setCreateDirty(true)}
    >
      <Form.Item label="Name" style={{ marginBottom: 24 }}>
        <Flex gap={8}>
          <Form.Item name="emoji" initialValue="👤" noStyle>
            <FormEmojiPickerInput fieldName="emoji" defaultEmoji="👤" />
          </Form.Item>
          <Form.Item name="name" noStyle style={{ flex: 1 }}>
            <Input placeholder="John Doe" style={{ flex: 1 }} />
          </Form.Item>
        </Flex>
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
        rules={[
          { required: true, message: 'Please enter a password' },
          { min: 8, message: 'Password must be at least 8 characters' },
        ]}
      >
        <Input.Password placeholder="••••••••" />
      </Form.Item>

      <Form.Item
        label="Role"
        name="role"
        initialValue={ROLES.MEMBER}
        rules={[{ required: true, message: 'Please select a role' }]}
      >
        <Select
          options={ROLE_OPTIONS.map((opt) => ({
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
  );

  // Edit reuses the full UserSettingsModal (embedded) so self-vs-other gating —
  // Force-password-change only when an admin edits someone else; own API
  // Tokens/Uploads only when editing yourself — is preserved exactly.
  if (editingUser) {
    return (
      <UserSettingsModal
        embedded
        backLabel="Back to Users"
        open
        onClose={() => {
          closeDrill();
          void loadGroups();
        }}
        user={editingUser}
        client={client}
        currentUser={currentUser}
        onUpdate={onUpdate}
      />
    );
  }

  if (isCreating) {
    return (
      <DrillInFrame title="New User" dirty={createDirty} saveLabel="Create" onSave={handleCreate}>
        {createFields}
      </DrillInFrame>
    );
  }

  return (
    <Tabs
      defaultActiveKey="users"
      items={[
        { key: 'users', label: 'Users', children: usersTable },
        ...(isAdmin
          ? [
              {
                key: 'avatars',
                label: 'Avatar sync',
                children: (
                  <UserAvatarsTab client={client} gatewayChannelById={gatewayChannelById} />
                ),
              },
            ]
          : []),
      ]}
    />
  );
};
