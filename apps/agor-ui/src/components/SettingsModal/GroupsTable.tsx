import type { AgorClient, Group, GroupMembership, User } from '@agor-live/client';
import { hasMinimumRole, hasRoleAuthorityOver, ROLES } from '@agor-live/client';
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
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type ActionErrorCopy,
  describeActionError,
  formatActionError,
  isInFlightConnectionLossError,
} from '@/utils/connectionErrors';
import { mapToSortedArray } from '@/utils/mapHelpers';
import { slugify } from '@/utils/repoSlug';
import { searchableSelectProps, toUserSelectOption } from '@/utils/selectSearch';
import { filterBySettingsSearch } from '@/utils/settingsSearch';
import { useThemedMessage } from '../../utils/message';
import { ActionErrorNotice } from '../CompactNotice';
import { HighlightMatch } from '../HighlightMatch';
import { UserIdentityAvatar } from '../UserIdentityAvatar';
import { syncGroupMembersForGroup } from './groupMembershipSync';
import { FIELD_WIDTHS, SectionDivider } from './panelPrimitives';
import { ResponsiveSettingsHeader } from './ResponsiveSettingsHeader';
import { ResponsiveTable } from './ResponsiveTable';
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
  const [loadError, setLoadError] = useState<ActionErrorCopy | null>(null);
  const [saveError, setSaveError] = useState<ActionErrorCopy | null>(null);
  const [saving, setSaving] = useState(false);
  // A create whose reply was lost may have landed; block a second click until the form changes.
  const [createUnconfirmed, setCreateUnconfirmed] = useState(false);

  const { drill, openDrill, closeDrill } = useSettingsDrill();

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

  // Revoking group changes (archive, removed members) make the daemon reconnect
  // every socket in the tenant, which drops a read sent meanwhile: read again
  // once the socket is back.
  useEffect(() => {
    const io = client?.io;
    if (!io) return;
    const reload = () => void load().catch(() => undefined);
    io.on('connect', reload);
    return () => {
      io.off('connect', reload);
    };
  }, [client, load]);

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
    drill?.mode === 'edit' && drill.recordId ? (groupById.get(drill.recordId) ?? null) : null;
  const isCreating = drill?.mode === 'create';

  const openEdit = useCallback(
    (group: Group) => openDrill({ mode: 'edit', recordId: group.group_id }),
    [openDrill]
  );
  const openCreate = useCallback(() => openDrill({ mode: 'create' }), [openDrill]);

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
  // resume from a clean slate. Reloads of the same group keep the draft.
  const seededGroupIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!editingGroup) {
      seededGroupIdRef.current = null;
      return;
    }
    if (seededGroupIdRef.current !== editingGroup.group_id) {
      seededGroupIdRef.current = editingGroup.group_id;
      slugEditedRef.current = false;
      setSaveError(null);
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
      setSaveError(null);
      setCreateUnconfirmed(false);
      form.resetFields();
      setEditingMemberIds([]);
      setDirty(false);
    }
  }, [isCreating, form]);

  // Auto-fill slug from name until the user edits the slug field directly.
  const handleValuesChange = useCallback(
    (changedValues: { name?: string; slug?: string }) => {
      setDirty(true);
      setCreateUnconfirmed(false);
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
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    setSaveError(null);
    setSaving(true);
    try {
      if (editingGroup) {
        await client.service('groups').patch(editingGroup.group_id, values);
        await syncGroupMembers(editingGroup, editingMemberIds);
      } else {
        await client.service('groups').create(values);
      }
    } catch (error) {
      if (editingGroup) {
        setSaveError(describeActionError('save the group', error, { idempotent: true }));
        // A partial save may have changed members, so the next attempt diffs against fresh data.
        await load();
      } else {
        setSaveError(describeActionError('create the group', error, { idempotent: false }));
        setCreateUnconfirmed(isInFlightConnectionLossError(error));
      }
      return;
    } finally {
      setSaving(false);
    }
    showSuccess(editingGroup ? 'Group updated.' : 'Group created.');
    setDirty(false);
    closeDrill();
    void load();
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
    try {
      await client.service('groups').patch(group.group_id, { archived: true });
    } catch (error) {
      showError(formatActionError('archive the group', error, { idempotent: true }));
      return;
    }
    // Not a re-read: the patch's socket is about to be reconnected (see above).
    setGroups((previous) => previous.filter((g) => g.group_id !== group.group_id));
    showSuccess('Group archived.');
  };

  if (!isAdmin) {
    return <Typography.Text type="secondary">Only admins can manage groups.</Typography.Text>;
  }

  // Superadmin authority hierarchy (#2496): you can only add/manage members you
  // outrank, so a user you lack authority over is offered but disabled.
  const userOptions = mapToSortedArray(userById, (a, b) => a.email.localeCompare(b.email)).map(
    (user) => ({
      ...toUserSelectOption(user),
      disabled: !hasRoleAuthorityOver(currentUser?.role, user.role),
    })
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
        saving={saving}
        saveDisabled={!editingGroup && createUnconfirmed}
        onSave={handleSave}
      >
        {saveError && <ActionErrorNotice error={saveError} style={{ marginBottom: 8 }} />}
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
      <ResponsiveSettingsHeader
        title="Groups"
        description="Manage groups and user memberships."
        search={
          <Input
            allowClear
            placeholder="Search name, slug, description, or members"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />
        }
        primaryActions={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            New Group
          </Button>
        }
      />

      {loadError && (
        <ActionErrorNotice
          error={loadError}
          action={{ label: 'Try again', onClick: () => void load() }}
          style={{ marginBottom: 8 }}
        />
      )}

      {loadError && groups.length === 0 ? null : filteredGroups.length === 0 ? (
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
        <ResponsiveTable
          primaryColumnKey="name"
          rowKey="group_id"
          size="small"
          pagination={false}
          dataSource={filteredGroups}
          columns={[
            {
              title: 'Group',
              key: 'name',
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
