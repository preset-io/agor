/**
 * Permissions Tab — owners + RBAC controls for a branch.
 *
 * Controlled by `useBranchModalForm`: state lives in the parent modal so the
 * Save action at the modal footer commits owners, permission tiers, and other
 * branch fields in one shot.
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import type { AgorClient, Board, BoardGroupGrantWithGroup, Group, User } from '@agor-live/client';
import { Alert, Descriptions, Form, Radio, Typography } from 'antd';
import { useEffect, useState } from 'react';
import {
  RbacPermissionFields,
  type RbacPermissionValue,
  rbacVisibilityFromOthersCan,
} from '../../permissions/RbacPermissionFields';
import type { GroupGrantsStatus, PermissionsFormState } from '../useBranchModalForm';

interface PermissionsTabProps {
  loadingOwners: boolean;
  canEdit: boolean;
  allUsers: User[];
  allGroups: Group[];
  groupGrantsStatus?: GroupGrantsStatus;
  groupGrantsError?: Error | null;
  currentUser?: User | null;
  client: AgorClient | null;
  board?: Board | null;
  state: PermissionsFormState;
  setField: <K extends keyof PermissionsFormState>(key: K, value: PermissionsFormState[K]) => void;
  ownersLoadError?: Error | null;
}

export const PermissionsTab: React.FC<PermissionsTabProps> = ({
  loadingOwners,
  canEdit,
  allUsers,
  allGroups = [],
  groupGrantsStatus = 'loaded',
  groupGrantsError,
  currentUser,
  client,
  board,
  state,
  setField,
  ownersLoadError,
}) => {
  const [boardOwners, setBoardOwners] = useState<User[]>([]);
  const [boardGroupGrants, setBoardGroupGrants] = useState<BoardGroupGrantWithGroup[]>([]);
  const [boardDefaultsLoading, setBoardDefaultsLoading] = useState(false);
  const [boardDefaultsError, setBoardDefaultsError] = useState<Error | null>(null);
  const permissionSource = state.permissionSource ?? 'override';
  const canEditBranchFallbacks = canEdit && permissionSource === 'override';
  const fieldValue: RbacPermissionValue = {
    visibility: rbacVisibilityFromOthersCan(state.othersCan),
    ownerIds: state.selectedOwnerIds,
    groupGrants: state.groupGrants ?? [],
    othersCan: state.othersCan,
    othersFsAccess: state.othersFsAccess,
    allowSessionSharing: state.allowSessionSharing,
  };

  const setPermissionField = <K extends keyof RbacPermissionValue>(
    key: K,
    value: RbacPermissionValue[K]
  ) => {
    if (key === 'ownerIds') setField('selectedOwnerIds', value as string[]);
    if (key === 'groupGrants')
      setField('groupGrants', value as PermissionsFormState['groupGrants']);
    if (key === 'othersCan') setField('othersCan', value as PermissionsFormState['othersCan']);
    if (key === 'othersFsAccess') {
      setField('othersFsAccess', value as PermissionsFormState['othersFsAccess']);
    }
    if (key === 'allowSessionSharing') setField('allowSessionSharing', value as boolean);
  };

  useEffect(() => {
    if (!client || !board?.board_id || permissionSource !== 'board') {
      setBoardOwners([]);
      setBoardGroupGrants([]);
      setBoardDefaultsError(null);
      return;
    }

    let cancelled = false;
    setBoardDefaultsLoading(true);
    setBoardDefaultsError(null);
    Promise.all([
      client.service('boards/:id/owners').find({ route: { id: board.board_id } }),
      client.service('boards/:id/group-grants').find({ route: { id: board.board_id } }),
    ])
      .then(([owners, grants]) => {
        if (cancelled) return;
        setBoardOwners(owners as User[]);
        setBoardGroupGrants(grants as BoardGroupGrantWithGroup[]);
      })
      .catch((error) => {
        if (cancelled) return;
        setBoardOwners([]);
        setBoardGroupGrants([]);
        setBoardDefaultsError(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        if (!cancelled) setBoardDefaultsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client, board?.board_id, permissionSource]);

  const boardOwnerNames = boardOwners.map((owner) => owner.name || owner.email || owner.user_id);
  const boardGroupLabels = boardGroupGrants.map((grant) => {
    const group = allGroups.find((candidate) => candidate.group_id === grant.group_id);
    const groupName = grant.group?.name || group?.name || grant.group_id;
    const fs = grant.fs_access ? `, FS: ${grant.fs_access}` : '';
    return `${groupName}: ${grant.can}${fs}`;
  });

  return (
    <div style={{ width: '100%', maxHeight: '70vh', overflowY: 'auto' }}>
      <Form layout="horizontal" colon={false}>
        <Form.Item
          label="Permission Mode"
          labelCol={{ span: 8 }}
          wrapperCol={{ span: 16 }}
          help={
            permissionSource === 'board'
              ? 'Uses board-level defaults for non-owner access.'
              : 'Uses branch-level permission overrides.'
          }
        >
          <Radio.Group
            value={permissionSource}
            disabled={!canEdit}
            onChange={(e) => setField('permissionSource', e.target.value)}
            options={[
              { value: 'board', label: 'Align with board permissions' },
              { value: 'override', label: 'Override board-level permissions' },
            ]}
          />
        </Form.Item>

        {permissionSource === 'board' && (
          <>
            <Form.Item wrapperCol={{ offset: 8, span: 16 }}>
              <Alert
                type="info"
                showIcon
                message="Aligned with board permissions"
                description="This branch inherits board-level visibility, board owners, board groups, and board fallback permissions. Switch to Override to edit branch-level private/shared permissions directly."
              />
            </Form.Item>
            <Form.Item label="Board defaults" labelCol={{ span: 8 }} wrapperCol={{ span: 16 }}>
              {board ? (
                <Descriptions size="small" column={1} bordered style={{ width: '100%' }}>
                  <Descriptions.Item label="Visibility">
                    {board.access_mode === 'private' ? 'Private' : 'Shared'}
                  </Descriptions.Item>
                  <Descriptions.Item label="Owners">
                    {boardDefaultsLoading
                      ? 'Loading…'
                      : boardOwnerNames.length > 0
                        ? boardOwnerNames.join(', ')
                        : 'None'}
                  </Descriptions.Item>
                  {boardDefaultsError && (
                    <Descriptions.Item label="Owner/group details">
                      <Typography.Text type="danger">
                        Could not load: {boardDefaultsError.message}
                      </Typography.Text>
                    </Descriptions.Item>
                  )}
                  {board.access_mode !== 'private' && (
                    <>
                      <Descriptions.Item label="Groups">
                        {boardDefaultsLoading
                          ? 'Loading…'
                          : boardGroupLabels.length > 0
                            ? boardGroupLabels.join(', ')
                            : 'None'}
                      </Descriptions.Item>
                      <Descriptions.Item label="Others can">
                        {board.default_others_can || 'session'}
                      </Descriptions.Item>
                      <Descriptions.Item label="Filesystem access">
                        {board.default_others_fs_access || 'read'}
                      </Descriptions.Item>
                      <Descriptions.Item label="Legacy session sharing">
                        {board.default_dangerously_allow_session_sharing ? 'Allowed' : 'Off'}
                      </Descriptions.Item>
                    </>
                  )}
                </Descriptions>
              ) : (
                <Typography.Text type="secondary">
                  Board defaults are unavailable for this branch.
                </Typography.Text>
              )}
            </Form.Item>
          </>
        )}

        {permissionSource === 'override' && (
          <RbacPermissionFields
            value={fieldValue}
            onChange={setPermissionField}
            allUsers={allUsers}
            allGroups={allGroups}
            currentUser={currentUser}
            canEdit={canEditBranchFallbacks}
            canEditGroups={canEditBranchFallbacks && groupGrantsStatus === 'loaded'}
            loadingOwners={loadingOwners}
            groupGrantsLoading={groupGrantsStatus === 'loading'}
            groupGrantsUnavailable={groupGrantsStatus === 'unavailable'}
            groupGrantsError={groupGrantsError}
            ownersLoadError={ownersLoadError}
            groupsHelp="Grant explicit branch access to user groups"
          />
        )}
      </Form>
    </div>
  );
};
