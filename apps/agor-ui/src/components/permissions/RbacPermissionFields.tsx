import type { BranchPermissionLevel, Group, User } from '@agor-live/client';
import { UserOutlined, WarningOutlined } from '@ant-design/icons';
import { Alert, Form, Radio, Select, Space, Switch, Typography } from 'antd';
import { useState } from 'react';
import { useThemedMessage } from '@/utils/message';
import {
  searchableSelectProps,
  selectSearchTextFromLabel,
  toGroupSelectOption,
  toUserSelectOption,
} from '@/utils/selectSearch';
import { Tag } from '../Tag';

export type FsAccessLevel = 'none' | 'read' | 'write';
export type RbacVisibility = 'private' | 'shared';

export interface RbacGroupGrantValue {
  group_id: string;
  can: BranchPermissionLevel;
  fs_access?: FsAccessLevel;
}

export interface RbacPermissionValue {
  visibility: RbacVisibility;
  ownerIds: string[];
  groupGrants: RbacGroupGrantValue[];
  othersCan: BranchPermissionLevel;
  othersFsAccess: FsAccessLevel;
  allowSessionSharing: boolean;
}

interface RbacPermissionFieldsProps {
  value: RbacPermissionValue;
  onChange: <K extends keyof RbacPermissionValue>(key: K, value: RbacPermissionValue[K]) => void;
  allUsers: User[];
  allGroups: Group[];
  currentUser?: User | null;
  canEdit: boolean;
  canEditOwners?: boolean;
  canEditGroups?: boolean;
  loadingOwners?: boolean;
  groupGrantsLoading?: boolean;
  groupGrantsUnavailable?: boolean;
  groupGrantsError?: Error | null;
  ownersLoadError?: Error | null;
  ownerHelp?: string;
  groupsHelp?: string;
  visibilityLabel?: string;
  othersCanLabel?: string;
  othersFsAccessLabel?: string;
  showLegacySessionSharing?: boolean;
}

const permissionLevelDescriptions: Record<BranchPermissionLevel, string> = {
  none: 'No access',
  view: 'View only',
  session: 'Create and prompt own sessions',
  prompt: 'Prompt any session',
  all: 'Full control',
};

const fsAccessDescriptions: Record<FsAccessLevel, string> = {
  none: 'No filesystem access',
  read: 'Read-only',
  write: 'Read/write',
};

export const rbacVisibilityFromOthersCan = (
  othersCan: BranchPermissionLevel | undefined
): RbacVisibility => (othersCan === 'none' ? 'private' : 'shared');

export const othersCanFromRbacVisibility = (
  visibility: RbacVisibility,
  previous: BranchPermissionLevel | undefined
): BranchPermissionLevel =>
  visibility === 'private' ? 'none' : previous === 'none' ? 'session' : previous || 'session';

export const RbacPermissionFields: React.FC<RbacPermissionFieldsProps> = ({
  value,
  onChange,
  allUsers,
  allGroups,
  currentUser,
  canEdit,
  canEditOwners = canEdit,
  canEditGroups = canEdit,
  loadingOwners = false,
  groupGrantsLoading = false,
  groupGrantsUnavailable = false,
  groupGrantsError,
  ownersLoadError,
  ownerHelp = 'Full access',
  groupsHelp = 'Group access',
  visibilityLabel = 'Visibility',
  othersCanLabel = 'Others Can',
  othersFsAccessLabel = 'Filesystem Access',
  showLegacySessionSharing = true,
}) => {
  const { showError } = useThemedMessage();
  const [selectKey, setSelectKey] = useState(0);
  const currentUserId = currentUser?.user_id;
  const isShared = value.visibility === 'shared';
  const ownerLabel = (ownerId: string) => {
    const user = allUsers.find((candidate) => candidate.user_id === ownerId);
    const name = user?.name || user?.email || ownerId;
    return ownerId === currentUserId ? `${name} (You)` : name;
  };
  const privateOwnerLabel =
    value.ownerIds.length === 1 ? `Private (${ownerLabel(value.ownerIds[0])})` : 'Private';

  const handleOwnersChange = (newOwnerIds: string[]) => {
    if (newOwnerIds.length === 0) {
      showError('At least one owner is required');
      setSelectKey((prev) => prev + 1);
      return;
    }
    onChange('ownerIds', newOwnerIds);
  };

  const handleVisibilityChange = (visibility: RbacVisibility) => {
    onChange('visibility', visibility);
    onChange('othersCan', othersCanFromRbacVisibility(visibility, value.othersCan));
    if (visibility === 'private') {
      const ownerId =
        value.ownerIds.length === 1
          ? value.ownerIds[0]
          : currentUserId && value.ownerIds.includes(currentUserId)
            ? currentUserId
            : value.ownerIds[0] || currentUserId;
      if (ownerId) onChange('ownerIds', [ownerId]);
      onChange('groupGrants', []);
      onChange('othersFsAccess', 'none');
      onChange('allowSessionSharing', false);
    }
  };

  return (
    <>
      {ownersLoadError && (
        <Alert
          type="error"
          showIcon
          message="Permissions unavailable"
          description={`${ownersLoadError.message}. Close and reopen the modal to retry.`}
          style={{ marginBottom: 16 }}
        />
      )}

      <Form.Item
        label={visibilityLabel}
        labelCol={{ span: 8 }}
        wrapperCol={{ span: 16 }}
        help={isShared ? 'Group and fallback access.' : 'Owner-only access.'}
      >
        <Radio.Group
          value={value.visibility}
          disabled={!canEdit}
          onChange={(e) => handleVisibilityChange(e.target.value)}
          options={[
            { value: 'private', label: privateOwnerLabel },
            { value: 'shared', label: 'Shared' },
          ]}
        />
      </Form.Item>

      {isShared && (
        <Form.Item label="Owners" labelCol={{ span: 8 }} wrapperCol={{ span: 16 }} help={ownerHelp}>
          <Select
            key={selectKey}
            mode="multiple"
            style={{ width: '100%' }}
            placeholder="Select owners..."
            value={value.ownerIds}
            onChange={handleOwnersChange}
            loading={loadingOwners}
            disabled={!canEditOwners}
            {...searchableSelectProps}
            options={allUsers
              .map((user) => {
                const isCurrentUser = user.user_id === currentUserId;
                const option = toUserSelectOption(user);
                const label = isCurrentUser ? `${option.label} (You)` : option.label;
                return { ...option, label, searchText: selectSearchTextFromLabel(label) };
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
      )}

      {isShared && (
        <>
          <Form.Item
            label="Groups"
            labelCol={{ span: 8 }}
            wrapperCol={{ span: 16 }}
            help={groupsHelp}
          >
            <Space direction="vertical" style={{ width: '100%' }}>
              {groupGrantsUnavailable && (
                <Alert
                  type="warning"
                  showIcon
                  message="Group permissions unavailable"
                  description={
                    groupGrantsError?.message
                      ? `Group permissions could not be loaded: ${groupGrantsError.message}`
                      : 'Group grants may not be enabled.'
                  }
                />
              )}
              <Select
                mode="multiple"
                style={{ width: '100%' }}
                placeholder="Select groups..."
                value={value.groupGrants.map((grant) => grant.group_id)}
                loading={groupGrantsLoading}
                disabled={!canEditGroups}
                options={allGroups
                  .map(toGroupSelectOption)
                  .sort((a, b) => a.label.localeCompare(b.label))}
                {...searchableSelectProps}
                onChange={(groupIds) => {
                  const existing = new Map(
                    value.groupGrants.map((grant) => [grant.group_id, grant])
                  );
                  onChange(
                    'groupGrants',
                    groupIds.map(
                      (groupId) => existing.get(groupId) || { group_id: groupId, can: 'view' }
                    )
                  );
                }}
              />
              {value.groupGrants.map((grant) => {
                const group = allGroups.find((g) => g.group_id === grant.group_id);
                return (
                  <Space
                    key={grant.group_id}
                    style={{ width: '100%', justifyContent: 'space-between' }}
                  >
                    <Typography.Text>{group?.name || grant.group_id}</Typography.Text>
                    <Space>
                      <Select
                        size="small"
                        style={{ width: 140 }}
                        value={grant.can}
                        disabled={!canEditGroups}
                        options={[
                          { value: 'view', label: 'View' },
                          { value: 'session', label: 'Own Sessions' },
                          { value: 'prompt', label: 'Prompt' },
                          { value: 'all', label: 'All' },
                        ]}
                        onChange={(can) =>
                          onChange(
                            'groupGrants',
                            value.groupGrants.map((g) =>
                              g.group_id === grant.group_id ? { ...g, can } : g
                            )
                          )
                        }
                      />
                      <Select
                        size="small"
                        style={{ width: 110 }}
                        value={grant.fs_access || 'read'}
                        disabled={!canEditGroups}
                        options={[
                          { value: 'none', label: 'No FS' },
                          { value: 'read', label: 'Read FS' },
                          { value: 'write', label: 'Write FS' },
                        ]}
                        onChange={(fsAccess) =>
                          onChange(
                            'groupGrants',
                            value.groupGrants.map((g) =>
                              g.group_id === grant.group_id ? { ...g, fs_access: fsAccess } : g
                            )
                          )
                        }
                      />
                    </Space>
                  </Space>
                );
              })}
            </Space>
          </Form.Item>

          <Form.Item
            label={othersCanLabel}
            labelCol={{ span: 8 }}
            wrapperCol={{ span: 16 }}
            help={permissionLevelDescriptions[value.othersCan]}
          >
            <Select
              value={value.othersCan}
              onChange={(othersCan) => onChange('othersCan', othersCan)}
              disabled={!canEdit}
              options={[
                { value: 'view', label: 'View' },
                { value: 'session', label: 'Own Sessions' },
                { value: 'prompt', label: 'Prompt' },
                { value: 'all', label: 'All' },
              ]}
            />
          </Form.Item>

          {value.othersCan === 'prompt' && (
            <Form.Item wrapperCol={{ offset: 8, span: 16 }}>
              <Alert
                type="warning"
                showIcon
                icon={<WarningOutlined />}
                message="Unix identity risk"
                description="Allows prompting sessions created by others; use only with trusted collaborators."
              />
            </Form.Item>
          )}

          <Form.Item
            label={othersFsAccessLabel}
            labelCol={{ span: 8 }}
            wrapperCol={{ span: 16 }}
            help={fsAccessDescriptions[value.othersFsAccess]}
          >
            <Select
              value={value.othersFsAccess}
              onChange={(othersFsAccess) => onChange('othersFsAccess', othersFsAccess)}
              disabled={!canEdit}
              options={[
                { value: 'none', label: 'None' },
                { value: 'read', label: 'Read' },
                { value: 'write', label: 'Write' },
              ]}
            />
          </Form.Item>

          {showLegacySessionSharing && (
            <Form.Item
              label="Allow legacy session sharing"
              labelCol={{ span: 8 }}
              wrapperCol={{ span: 16 }}
              help="When on, spawned/forked sessions keep the original creator's identity."
            >
              <Switch
                checked={value.allowSessionSharing}
                onChange={(allowSessionSharing) =>
                  onChange('allowSessionSharing', allowSessionSharing)
                }
                disabled={!canEdit}
              />
            </Form.Item>
          )}

          {showLegacySessionSharing && value.allowSessionSharing && (
            <Form.Item wrapperCol={{ offset: 8, span: 16 }}>
              <Alert
                type="error"
                showIcon
                icon={<WarningOutlined />}
                message="Dangerous: identity borrowing"
                description="Use only for trusted collaborators or legacy automation."
              />
            </Form.Item>
          )}
        </>
      )}
    </>
  );
};
