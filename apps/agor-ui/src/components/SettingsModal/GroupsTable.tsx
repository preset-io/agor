import type { AgorClient, Group, GroupMembership, User } from '@agor-live/client';
import { hasMinimumRole, hasRoleAuthorityOver, ROLES } from '@agor-live/client';
import { DeleteOutlined, EditOutlined, PlusOutlined, TeamOutlined } from '@ant-design/icons';
import { Button, Form, Input, Popconfirm, Select, Space, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { describeActionError, formatActionError } from '@/utils/connectionErrors';
import { mapToSortedArray } from '@/utils/mapHelpers';
import { slugify } from '@/utils/repoSlug';
import { searchableSelectProps, toUserSelectOption } from '@/utils/selectSearch';
import { filterBySettingsSearch } from '@/utils/settingsSearch';
import { useThemedMessage } from '../../utils/message';
import { ActionErrorNotice } from '../CompactNotice';
import { HighlightMatch } from '../HighlightMatch';
import { AdaptiveSettingsModal } from './AdaptiveSettingsModal';
import { syncGroupMembersForGroup } from './groupMembershipSync';
import { ResponsiveSettingsHeader } from './ResponsiveSettingsHeader';
import { ResponsiveTable } from './ResponsiveTable';
import { SettingsActionGroup } from './SettingsActionGroup';

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
  type ActionError = ReturnType<typeof describeActionError>;
  const [loadError, setLoadError] = useState<ActionError | null>(null);
  const [createError, setCreateError] = useState<ActionError | null>(null);
  const [saveError, setSaveError] = useState<ActionError | null>(null);

  const load = useCallback(async () => {
    if (!client || !isAdmin) {
      setGroups([]);
      setMemberships([]);
      setLoadError(null);
      return;
    }
    try {
      const [nextGroups, nextMemberships] = await Promise.all([
        client.service('groups').findAll({ query: { archived: false } }),
        client.service('group-memberships').findAll({}),
      ]);
      setGroups(nextGroups as Group[]);
      setMemberships(nextMemberships as GroupMembership[]);
      setLoadError(null);
    } catch (error) {
      setLoadError(describeActionError('load groups', error, { idempotent: true }));
    }
  }, [client, isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

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
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    setCreateError(null);
    try {
      await client.service('groups').create(values);
    } catch (error) {
      setCreateError(describeActionError('create the group', error, { idempotent: false }));
      return;
    }
    closeCreateModal();
    showSuccess('Group created.');
    await load();
  };

  const openCreateModal = () => {
    createSlugEditedRef.current = false;
    form.resetFields();
    setCreateOpen(true);
  };

  const closeCreateModal = () => {
    createSlugEditedRef.current = false;
    setCreateError(null);
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
    const values = await editForm.validateFields().catch(() => null);
    if (!values) return;
    setSaveError(null);
    try {
      await client.service('groups').patch(editingGroup.group_id, values);
      await syncGroupMembers(editingGroup, editingMemberIds);
    } catch (error) {
      setSaveError(describeActionError('save the group', error, { idempotent: true }));
      // A partial save may have changed members, so the next attempt diffs against fresh data.
      await load();
      return;
    }
    setEditingGroup(null);
    setEditingMemberIds([]);
    showSuccess('Group updated.');
    await load();
  };

  const archiveGroup = async (group: Group) => {
    if (!client) return;
    try {
      await client.service('groups').patch(group.group_id, { archived: true });
    } catch (error) {
      showError(formatActionError('archive the group', error, { idempotent: true }));
      return;
    }
    showSuccess('Group archived.');
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
    try {
      await syncGroupMembers(group, nextUserIds);
    } catch (error) {
      showError(formatActionError('update the members', error, { idempotent: true }));
    }
    await load();
  };

  if (!isAdmin) {
    return <Typography.Text type="secondary">Only admins can manage groups.</Typography.Text>;
  }

  const userOptions = mapToSortedArray(userById, (a, b) => a.email.localeCompare(b.email)).map(
    (user) => ({
      ...toUserSelectOption(user),
      disabled: !hasRoleAuthorityOver(currentUser?.role, user.role),
    })
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
      <ResponsiveSettingsHeader
        description="Manage groups and user memberships."
        actions={(compact) => (
          <Space wrap style={{ width: compact ? '100%' : undefined }}>
            <Input
              allowClear
              placeholder="Search name, slug, description, or members"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              style={{ width: compact ? '100%' : 320, flex: compact ? '1 1 100%' : undefined }}
            />
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreateModal}>
              New Group
            </Button>
          </Space>
        )}
      />

      {loadError && (
        <ActionErrorNotice
          error={loadError}
          action={{ label: 'Try again', onClick: () => void load() }}
          style={{ marginBottom: 8 }}
        />
      )}

      <ResponsiveTable
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
                style={{ width: '100%', minWidth: 0 }}
                value={membershipsByGroup.get(group.group_id) || []}
                options={userOptions}
                {...searchableSelectProps}
                onChange={(ids) => setGroupMembers(group, ids)}
              />
            ),
          },
          {
            title: 'Actions',
            key: 'actions',
            width: 76,
            render: (_: unknown, group: Group) => (
              <SettingsActionGroup>
                <Button
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => {
                    editSlugEditedRef.current = false;
                    setSaveError(null);
                    setEditingGroup(group);
                    setEditingMemberIds(membershipsByGroup.get(group.group_id) || []);
                    editForm.setFieldsValue(group);
                  }}
                />
                <Popconfirm title="Archive group?" onConfirm={() => archiveGroup(group)}>
                  <Button type="text" size="small" icon={<DeleteOutlined />} danger />
                </Popconfirm>
              </SettingsActionGroup>
            ),
          },
        ]}
        scroll={{ x: 700 }}
      />

      <AdaptiveSettingsModal
        title="Create Group"
        open={createOpen}
        onOk={createGroup}
        onCancel={closeCreateModal}
      >
        {createError && <ActionErrorNotice error={createError} style={{ marginBottom: 8 }} />}
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
      </AdaptiveSettingsModal>
      <AdaptiveSettingsModal
        title="Edit Group"
        open={!!editingGroup}
        onOk={saveGroup}
        onCancel={() => {
          setEditingGroup(null);
          setEditingMemberIds([]);
          setSaveError(null);
        }}
      >
        {saveError && <ActionErrorNotice error={saveError} style={{ marginBottom: 8 }} />}
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
      </AdaptiveSettingsModal>
    </div>
  );
};
