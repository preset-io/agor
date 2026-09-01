import type { AgorClient, Group, GroupMembership, User } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { EditOutlined, InboxOutlined, PlusOutlined, TeamOutlined } from '@ant-design/icons';
import {
  Avatar,
  Button,
  Empty,
  Form,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mapToSortedArray } from '@/utils/mapHelpers';
import { slugify } from '@/utils/repoSlug';
import { searchableSelectProps, toUserSelectOption } from '@/utils/selectSearch';
import { filterBySettingsSearch } from '@/utils/settingsSearch';
import { useThemedMessage } from '../../utils/message';
import { HighlightMatch } from '../HighlightMatch';
import { UserIdentityAvatar } from '../UserIdentityAvatar';
import { syncGroupMembersForGroup } from './groupMembershipSync';
import { FIELD_WIDTHS, ListPanelHeader, SectionDivider } from './panelPrimitives';
import { SettingsActionGroup } from './SettingsActionGroup';
import { DrillInFrame, useSettingsDrill } from './SettingsDrill';

interface GroupsTableProps {
  client: AgorClient | null;
  currentUser?: User | null;
  userById: Map<string, User>;
}

export const GroupsTable: React.FC<GroupsTableProps> = ({ client, currentUser, userById }) => {
  const { showError, showSuccess } = useThemedMessage();
  const [groups, setGroups] = useState<Group[]>([]);
  const [memberships, setMemberships] = useState<GroupMembership[]>([]);
  const [editingMemberIds, setEditingMemberIds] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [dirty, setDirty] = useState(false);
  const [form] = Form.useForm();
  const slugEditedRef = useRef(false);
  const isAdmin = hasMinimumRole(currentUser?.role, ROLES.ADMIN);

  const { drill, openDrill, closeDrill } = useSettingsDrill();

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

  const groupById = useMemo(() => {
    const map = new Map<string, Group>();
    for (const group of groups) map.set(group.group_id, group);
    return map;
  }, [groups]);

  // Editing/creating swaps this section's Content pane for the drill-in editor
  // below, instead of stacking a second Modal on top of Settings.
  const editingGroup =
    drill?.kind === 'groups' && drill.mode === 'edit' && drill.recordId
      ? (groupById.get(drill.recordId) ?? null)
      : null;
  const isCreating = drill?.kind === 'groups' && drill.mode === 'create';

  const openEdit = useCallback(
    (group: Group) => openDrill({ kind: 'groups', mode: 'edit', recordId: group.group_id }),
    [openDrill]
  );
  const openCreate = useCallback(() => openDrill({ kind: 'groups', mode: 'create' }), [openDrill]);

  const syncGroupMembers = useCallback(
    async (group: Group, nextUserIds: string[]) => {
      if (!client) return;
      await syncGroupMembersForGroup(
        client,
        group.group_id,
        membershipsByGroup.get(group.group_id) || [],
        nextUserIds
      );
    },
    [client, membershipsByGroup]
  );

  // Seed the form whenever the drill-in targets a group (edit) or opens fresh
  // (create). The slug auto-fill flag is reset alongside so name-driven slugs
  // resume from a clean slate.
  useEffect(() => {
    if (editingGroup) {
      slugEditedRef.current = false;
      form.setFieldsValue({
        name: editingGroup.name,
        slug: editingGroup.slug || '',
        description: editingGroup.description || '',
      });
      setEditingMemberIds(membershipsByGroup.get(editingGroup.group_id) || []);
      setDirty(false);
    }
  }, [editingGroup, form, membershipsByGroup]);

  useEffect(() => {
    if (isCreating) {
      slugEditedRef.current = false;
      form.resetFields();
      setEditingMemberIds([]);
      setDirty(false);
    }
  }, [isCreating, form]);

  // Auto-fill slug from name until the user edits the slug field directly.
  const handleValuesChange = useCallback(
    (changedValues: { name?: string; slug?: string }) => {
      setDirty(true);
      if (Object.hasOwn(changedValues, 'slug')) {
        slugEditedRef.current = true;
        return;
      }
      if (Object.hasOwn(changedValues, 'name') && !slugEditedRef.current) {
        form.setFieldsValue({ slug: slugify(changedValues.name || '') });
      }
    },
    [form]
  );

  const handleSave = useCallback(async () => {
    if (!client) return;
    const values = await form.validateFields();
    if (editingGroup) {
      await client.service('groups').patch(editingGroup.group_id, values);
      await syncGroupMembers(editingGroup, editingMemberIds);
      showSuccess('Group updated');
    } else {
      await client.service('groups').create(values);
      showSuccess('Group created');
    }
    setDirty(false);
    closeDrill();
    await load();
  }, [
    client,
    form,
    editingGroup,
    editingMemberIds,
    syncGroupMembers,
    showSuccess,
    closeDrill,
    load,
  ]);

  const archiveGroup = async (group: Group) => {
    if (!client) return;
    await client.service('groups').patch(group.group_id, { archived: true });
    showSuccess('Group archived');
    await load();
  };

  if (!isAdmin) {
    return <Typography.Text type="secondary">Only admins can manage groups.</Typography.Text>;
  }

  const userOptions = mapToSortedArray(userById, (a, b) => a.email.localeCompare(b.email)).map(
    toUserSelectOption
  );

  const activeGroups = [...groups].sort((a, b) => a.name.localeCompare(b.name));
  const filteredGroups = filterBySettingsSearch(activeGroups, searchTerm, [
    (group) => group.name,
    (group) => group.slug,
    (group) => group.description,
    (group) =>
      (membershipsByGroup.get(group.group_id) || [])
        .map((userId) => userById.get(userId))
        .filter((user): user is User => Boolean(user))
        .flatMap((user) => [user.name, user.email, user.unix_username]),
  ]);

  if (editingGroup || isCreating) {
    return (
      <DrillInFrame
        title={editingGroup ? `Edit ${editingGroup.name}` : 'New Group'}
        dirty={dirty}
        onSave={handleSave}
      >
        <Form
          form={form}
          layout="vertical"
          style={{ maxWidth: 520 }}
          onValuesChange={handleValuesChange}
        >
          <SectionDivider label="Details" />
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="slug"
            label="Slug"
            tooltip={
              editingGroup
                ? 'Editable stable key used in URLs and APIs.'
                : 'Auto-filled from name; editable.'
            }
          >
            <Input placeholder="engineering" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>
          {editingGroup && (
            <>
              <SectionDivider label="Members" />
              <Form.Item label="Members">
                <Select
                  mode="multiple"
                  style={{ width: '100%', ...FIELD_WIDTHS.medium }}
                  value={editingMemberIds}
                  options={userOptions}
                  {...searchableSelectProps}
                  onChange={(ids) => {
                    setEditingMemberIds(ids);
                    setDirty(true);
                  }}
                  placeholder="Select users..."
                />
              </Form.Item>
            </>
          )}
        </Form>
      </DrillInFrame>
    );
  }

  return (
    <div>
      <ListPanelHeader
        title="Groups"
        description="Manage groups and user memberships."
        search={
          <Input
            allowClear
            placeholder="Search name, slug, description, or members"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            style={{ width: 320 }}
          />
        }
        actions={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            New Group
          </Button>
        }
      />

      {filteredGroups.length === 0 ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 400,
          }}
        >
          {activeGroups.length === 0 ? (
            <Empty description="No groups yet">
              <Typography.Text type="secondary">
                Create a group to organize users and manage memberships.
              </Typography.Text>
            </Empty>
          ) : (
            <Empty description={`No groups match “${searchTerm}”`} />
          )}
        </div>
      ) : (
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
                  <Typography.Link title={group.name} onClick={() => openEdit(group)}>
                    <HighlightMatch text={group.name} query={searchTerm} />
                  </Typography.Link>
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
              // Read-only here — membership is edited only in the drill-in, so
              // there's one editing path instead of a list-cell autosave that
              // silently differed from the drill-in form.
              render: (_: unknown, group: Group) => {
                const memberIds = membershipsByGroup.get(group.group_id) || [];
                if (memberIds.length === 0) {
                  return <Typography.Text type="secondary">No members</Typography.Text>;
                }
                const members = memberIds
                  .map((id) => userById.get(id))
                  .filter((u): u is User => Boolean(u));
                return (
                  <Space size={8}>
                    <Avatar.Group max={{ count: 5 }}>
                      {members.map((u) => (
                        <UserIdentityAvatar key={u.user_id} user={u} size={24} fontSize="12px" />
                      ))}
                    </Avatar.Group>
                    <Typography.Text type="secondary">
                      {memberIds.length} {memberIds.length === 1 ? 'member' : 'members'}
                    </Typography.Text>
                  </Space>
                );
              },
            },
            {
              title: 'Actions',
              width: 76,
              render: (_: unknown, group: Group) => (
                <SettingsActionGroup>
                  <Tooltip title="Edit group">
                    <Button
                      type="text"
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => openEdit(group)}
                    />
                  </Tooltip>
                  <Popconfirm title="Archive group?" onConfirm={() => archiveGroup(group)}>
                    <Tooltip title="Archive group">
                      <Button type="text" size="small" icon={<InboxOutlined />} />
                    </Tooltip>
                  </Popconfirm>
                </SettingsActionGroup>
              ),
            },
          ]}
        />
      )}
    </div>
  );
};
