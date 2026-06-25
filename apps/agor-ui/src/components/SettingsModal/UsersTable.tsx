import type {
  AgorClient,
  CreateUserInput,
  GatewayChannel,
  Group,
  GroupMembership,
  MCPServer,
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
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { mapToSortedArray } from '@/utils/mapHelpers';
import { filterBySettingsSearch } from '@/utils/settingsSearch';
import { useThemedMessage } from '../../utils/message';
import { FormEmojiPickerInput } from '../EmojiPickerInput';
import { HighlightMatch } from '../HighlightMatch';
import { UserIdentityAvatar } from '../UserIdentityAvatar';
import { SettingsActionGroup } from './SettingsActionGroup';
import { UserAvatarsTab } from './UserAvatarsTab';
import { UserSettingsModal } from './UserSettingsModal';

interface UsersTableProps {
  userById: Map<string, User>;
  mcpServerById: Map<string, MCPServer>;
  gatewayChannelById?: Map<string, GatewayChannel>;
  client: AgorClient | null;
  currentUser?: User | null;
  onCreate?: (data: CreateUserInput) => void;
  onUpdate?: (userId: string, updates: UpdateUserInput) => void;
  onDelete?: (userId: string) => void;
}

export const UsersTable: React.FC<UsersTableProps> = ({
  userById,
  mcpServerById,
  gatewayChannelById = new Map(),
  client,
  currentUser,
  onCreate,
  onUpdate,
  onDelete,
}) => {
  const { showError } = useThemedMessage();
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [memberships, setMemberships] = useState<GroupMembership[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [form] = Form.useForm();
  const isAdmin = hasMinimumRole(currentUser?.role, ROLES.ADMIN);

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
        setCreateModalOpen(false);
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
      render: (_: unknown, user: User) => (
        <SettingsActionGroup>
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            onClick={() => setEditingUser(user)}
          />
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
      <div
        style={{
          marginBottom: 16,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Typography.Text type="secondary">Manage user accounts and permissions.</Typography.Text>
        <Space>
          <Input
            allowClear
            placeholder="Search name, email, username, role, or groups"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            style={{ width: 320 }}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalOpen(true)}>
            New User
          </Button>
        </Space>
      </div>

      <Table
        dataSource={users}
        columns={columns}
        rowKey="user_id"
        pagination={false}
        size="small"
      />

      {/* Create User Modal */}
      <Modal
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
          <Form.Item label="Name" style={{ marginBottom: 24 }}>
            <Flex gap={8}>
              <Form.Item name="emoji" initialValue="👤" noStyle>
                <FormEmojiPickerInput form={form} fieldName="emoji" defaultEmoji="👤" />
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
            label="Unix Username"
            name="unix_username"
            help="Optional. Unix user for process impersonation (alphanumeric, hyphens, underscores only)"
            rules={[
              {
                pattern: /^[a-z0-9_-]+$/,
                message: 'Only lowercase letters, numbers, hyphens, and underscores allowed',
              },
              { max: 32, message: 'Unix username must be 32 characters or less' },
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
      </Modal>

      {/* Edit User Modal - reuses UserSettingsModal */}
      <UserSettingsModal
        open={!!editingUser}
        onClose={() => {
          setEditingUser(null);
          void loadGroups();
        }}
        user={editingUser}
        mcpServerById={mcpServerById}
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
        ...(isAdmin
          ? [
              {
                key: 'avatars',
                label: 'Avatars',
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
