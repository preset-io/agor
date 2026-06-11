import type { AgorClient, Group, GroupMembership, User } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { DeleteOutlined, EditOutlined, PlusOutlined, TeamOutlined } from '@ant-design/icons';
import {
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mapToSortedArray } from '@/utils/mapHelpers';
import { slugify } from '@/utils/repoSlug';
import { searchableSelectProps, toUserSelectOption } from '@/utils/selectSearch';
import { filterBySettingsSearch } from '@/utils/settingsSearch';
import { useThemedMessage } from '../../utils/message';
import { HighlightMatch } from '../HighlightMatch';
import { syncGroupMembersForGroup } from './groupMembershipSync';

interface GroupsTableProps {
  client: AgorClient | null;
  currentUser?: User | null;
  userById: Map<string, User>;
}

export const GroupsTable: React.FC<GroupsTableProps> = ({ client, currentUser, userById }) => {
  const { showError, showSuccess } = useThemedMessage();
  const [groups, setGroups] = useState<Group[]>([]);
  const [memberships, setMemberships] = useState<GroupMembership[]>([]);
  const [editingGroup, setEditingGroup] = useState<Group | null>(null);
  const [editingMemberIds, setEditingMemberIds] = useState<string[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const createSlugEditedRef = useRef(false);
  const editSlugEditedRef = useRef(false);
  const isAdmin = hasMinimumRole(currentUser?.role, ROLES.ADMIN);

  const load = useCallback(async () => {
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
    load().catch((error) =>
      showError(`Failed to load groups: ${error instanceof Error ? error.message : String(error)}`)
    );
  }, [load, showError]);

  const membershipsByGroup = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const membership of memberships) {
      const ids = map.get(membership.group_id) || [];
      ids.push(membership.user_id);
      map.set(membership.group_id, ids);
    }
    return map;
  }, [memberships]);

  const createGroup = async () => {
    if (!client) return;
    const values = await form.validateFields();
    await client.service('groups').create(values);
    closeCreateModal();
    showSuccess('Group created');
    await load();
  };

  const openCreateModal = () => {
    createSlugEditedRef.current = false;
    form.resetFields();
    setCreateOpen(true);
  };

  const closeCreateModal = () => {
    createSlugEditedRef.current = false;
    form.resetFields();
    setCreateOpen(false);
  };

  const handleCreateValuesChange = (changedValues: { name?: string; slug?: string }) => {
    if (Object.hasOwn(changedValues, 'slug')) {
      createSlugEditedRef.current = true;
      return;
    }

    if (Object.hasOwn(changedValues, 'name') && !createSlugEditedRef.current) {
      form.setFieldsValue({ slug: slugify(changedValues.name || '') });
    }
  };

  const handleEditValuesChange = (changedValues: { name?: string; slug?: string }) => {
    if (Object.hasOwn(changedValues, 'slug')) {
      editSlugEditedRef.current = true;
      return;
    }

    if (
      Object.hasOwn(changedValues, 'name') &&
      !editSlugEditedRef.current &&
      !editForm.getFieldValue('slug')
    ) {
      editForm.setFieldsValue({ slug: slugify(changedValues.name || '') });
    }
  };

  const saveGroup = async () => {
    if (!client || !editingGroup) return;
    const values = await editForm.validateFields();
    await client.service('groups').patch(editingGroup.group_id, values);
    await syncGroupMembers(editingGroup, editingMemberIds);
    setEditingGroup(null);
    setEditingMemberIds([]);
    showSuccess('Group updated');
    await load();
  };

  const archiveGroup = async (group: Group) => {
    if (!client) return;
    await client.service('groups').patch(group.group_id, { archived: true });
    showSuccess('Group archived');
    await load();
  };

  const syncGroupMembers = async (group: Group, nextUserIds: string[]) => {
    if (!client) return;
    await syncGroupMembersForGroup(
      client,
      group.group_id,
      membershipsByGroup.get(group.group_id) || [],
      nextUserIds
    );
  };

  const setGroupMembers = async (group: Group, nextUserIds: string[]) => {
    await syncGroupMembers(group, nextUserIds);
    await load();
  };

  if (!isAdmin) {
    return <Typography.Text type="secondary">Only admins can manage groups.</Typography.Text>;
  }

  const userOptions = mapToSortedArray(userById, (a, b) => a.email.localeCompare(b.email)).map(
    toUserSelectOption
  );
  const filteredGroups = filterBySettingsSearch(
    [...groups].sort((a, b) => a.name.localeCompare(b.name)),
    searchTerm,
    [
      (group) => group.name,
      (group) => group.slug,
      (group) => group.description,
      (group) =>
        (membershipsByGroup.get(group.group_id) || [])
          .map((userId) => userById.get(userId))
          .filter((user): user is User => Boolean(user))
          .flatMap((user) => [user.name, user.email, user.unix_username]),
    ]
  );
  return (
    <div>
      <div
        style={{
          marginBottom: 16,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Typography.Text type="secondary">Manage groups and user memberships.</Typography.Text>
        <Space>
          <Input
            allowClear
            placeholder="Search name, slug, description, or members"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            style={{ width: 320 }}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreateModal}>
            New Group
          </Button>
        </Space>
      </div>

      <Table
        rowKey="group_id"
        size="small"
        pagination={false}
        dataSource={filteredGroups}
        columns={[
          {
            title: 'Group',
            dataIndex: 'name',
            render: (_: string, group: Group) => (
              <Space>
                <TeamOutlined />
                <span>
                  <HighlightMatch text={group.name} query={searchTerm} />
                </span>
                <Tag>
                  <HighlightMatch text={group.slug || ''} query={searchTerm} />
                </Tag>
              </Space>
            ),
          },
          {
            title: 'Description',
            dataIndex: 'description',
            render: (v?: string) => (v ? <HighlightMatch text={v} query={searchTerm} /> : '—'),
          },
          {
            title: 'Members',
            render: (_: unknown, group: Group) => (
              <Select
                mode="multiple"
                style={{ minWidth: 320 }}
                value={membershipsByGroup.get(group.group_id) || []}
                options={userOptions}
                {...searchableSelectProps}
                onChange={(ids) => setGroupMembers(group, ids)}
              />
            ),
          },
          {
            title: 'Actions',
            width: 110,
            render: (_: unknown, group: Group) => (
              <Space>
                <Button
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => {
                    editSlugEditedRef.current = false;
                    setEditingGroup(group);
                    setEditingMemberIds(membershipsByGroup.get(group.group_id) || []);
                    editForm.setFieldsValue(group);
                  }}
                />
                <Popconfirm title="Archive group?" onConfirm={() => archiveGroup(group)}>
                  <Button type="text" size="small" icon={<DeleteOutlined />} danger />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal title="Create Group" open={createOpen} onOk={createGroup} onCancel={closeCreateModal}>
        <Form form={form} layout="vertical" onValuesChange={handleCreateValuesChange}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="slug" label="Slug" extra="Auto-filled from name; editable.">
            <Input placeholder="engineering" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="Edit Group"
        open={!!editingGroup}
        onOk={saveGroup}
        onCancel={() => {
          setEditingGroup(null);
          setEditingMemberIds([]);
        }}
      >
        <Form form={editForm} layout="vertical" onValuesChange={handleEditValuesChange}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="slug" label="Slug" extra="Editable stable key used in URLs and APIs.">
            <Input />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item label="Members">
            <Select
              mode="multiple"
              style={{ width: '100%' }}
              value={editingMemberIds}
              options={userOptions}
              {...searchableSelectProps}
              onChange={setEditingMemberIds}
              placeholder="Select users..."
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};
