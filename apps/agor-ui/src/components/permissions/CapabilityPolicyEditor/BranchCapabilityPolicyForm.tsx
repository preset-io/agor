import type {
  BranchCapabilityPolicyDraft,
  BranchPermissionConfigDraft,
  CapabilityPolicyDraft,
  CapabilityPolicyPrincipalDescriptor,
  UserID,
} from '@agor/core/types';
import { CAPABILITY_POLICY_SCHEMA_VERSION } from '@agor/core/types';
import { Alert, Button, Divider, Flex, Typography, theme } from 'antd';
import { useState } from 'react';
import { BranchPermissionConfigEditor } from './BranchPermissionConfigEditor';
import type { EffectiveAccessSubject } from './effectiveAccessPreviewModel';
import { ImmutablePrimaryOwner } from './ImmutablePrimaryOwner';
import { PolicyModeSelector, type PolicyModeSelectorValue } from './PolicyModeSelector';
import {
  capabilityPolicyHasAudience,
  makePrivatePolicy,
  makeSharedClosedPolicy,
} from './policyEditorModel';

interface BranchCapabilityPolicyFormProps {
  value: BranchCapabilityPolicyDraft;
  onChange: (value: BranchCapabilityPolicyDraft) => void;
  principals: CapabilityPolicyPrincipalDescriptor[];
  subjects: EffectiveAccessSubject[];
  sessionSharingWorkspaceEnabled?: boolean;
  canManageAccess?: boolean;
}

function findUserDescriptor(
  principals: CapabilityPolicyPrincipalDescriptor[],
  userId: UserID
): CapabilityPolicyPrincipalDescriptor | undefined {
  return principals.find(
    (principal) =>
      principal.principal.principal_type === 'user' && principal.principal.user_id === userId
  );
}

const privateBranchPolicy = (): CapabilityPolicyDraft => ({
  schema_version: CAPABILITY_POLICY_SCHEMA_VERSION,
  policy_kind: 'branch_access',
  sharing_mode: 'private',
  entries: [],
  others: { preset: 'none', capabilities: [], fs_access: 'none' },
});

const privateBranchConfig = (): BranchPermissionConfigDraft => ({
  access: privateBranchPolicy(),
  allow_shared_session_prompts: false,
});

export const BranchCapabilityPolicyForm: React.FC<BranchCapabilityPolicyFormProps> = ({
  value,
  onChange,
  principals,
  subjects,
  sessionSharingWorkspaceEnabled = true,
  canManageAccess = true,
}) => {
  const { token } = theme.useToken();
  const [confirmInherit, setConfirmInherit] = useState(false);
  const [confirmPrivate, setConfirmPrivate] = useState(false);
  const owner = findUserDescriptor(principals, value.primary_owner_user_id);
  const inheritedConfig = value.inherited_config ?? privateBranchConfig();
  const effectiveConfig =
    value.binding_mode === 'override'
      ? (value.override_config ?? structuredClone(inheritedConfig))
      : inheritedConfig;
  const selectedMode: PolicyModeSelectorValue =
    value.binding_mode === 'inherit' ? 'inherit' : effectiveConfig.access.sharing_mode;

  const applyOverrideMode = (mode: 'private' | 'shared') => {
    const nextConfig = structuredClone(effectiveConfig);
    if (nextConfig.access.sharing_mode !== mode) {
      nextConfig.access =
        mode === 'private'
          ? makePrivatePolicy(nextConfig.access)
          : makeSharedClosedPolicy(nextConfig.access);
    }
    onChange({
      ...value,
      binding_mode: 'override',
      override_config: nextConfig,
    });
    setConfirmInherit(false);
    setConfirmPrivate(false);
  };

  const setMode = (mode: PolicyModeSelectorValue) => {
    if (mode === selectedMode) return;
    setConfirmInherit(false);
    setConfirmPrivate(false);

    if (mode === 'inherit') {
      if (!value.override_config) {
        onChange({ ...value, binding_mode: 'inherit', override_config: undefined });
        return;
      }
      setConfirmInherit(true);
      return;
    }

    if (
      mode === 'private' &&
      effectiveConfig.access.sharing_mode !== 'private' &&
      capabilityPolicyHasAudience(effectiveConfig.access)
    ) {
      setConfirmPrivate(true);
      return;
    }
    applyOverrideMode(mode);
  };

  return (
    <Flex vertical gap={token.paddingMD}>
      <div>
        <Typography.Title level={4} style={{ marginBottom: token.paddingXXS }}>
          Branch permissions
        </Typography.Title>
      </div>
      <ImmutablePrimaryOwner owner={owner} resourceLabel="branch" />
      <Divider style={{ marginBlock: 0 }} />

      <PolicyModeSelector
        mode="inheritable"
        title="Access"
        ariaLabel="Branch permission mode"
        value={selectedMode}
        onChange={setMode}
        disabled={!canManageAccess}
        descriptions={{
          inherit: 'Uses board defaults for access, files, and session sharing.',
          private: 'Only the primary owner can access this branch.',
          shared: 'Configure access for this branch.',
        }}
      />
      {confirmInherit && (
        <Alert
          type="warning"
          showIcon
          description="Discard this override and follow the board defaults?"
          action={
            <Flex gap={token.paddingXS} wrap>
              <Button size="small" onClick={() => setConfirmInherit(false)}>
                Keep override
              </Button>
              <Button
                size="small"
                danger
                type="primary"
                onClick={() => {
                  onChange({ ...value, binding_mode: 'inherit', override_config: undefined });
                  setConfirmInherit(false);
                }}
              >
                Discard & inherit
              </Button>
            </Flex>
          }
        />
      )}

      {confirmPrivate && (
        <Alert
          type="warning"
          showIcon
          description="Make this owner-only? Named entries and Others will be removed."
          action={
            <Flex gap={token.paddingXS} wrap>
              <Button size="small" onClick={() => setConfirmPrivate(false)}>
                Keep shared
              </Button>
              <Button
                size="small"
                danger
                type="primary"
                onClick={() => applyOverrideMode('private')}
              >
                Make private
              </Button>
            </Flex>
          }
        />
      )}

      <BranchPermissionConfigEditor
        accessTitle="Branch access"
        value={effectiveConfig}
        onChange={(overrideConfig) => onChange({ ...value, override_config: overrideConfig })}
        accessReadOnly={value.binding_mode === 'inherit' || !canManageAccess}
        sharingReadOnly={value.binding_mode === 'inherit' || !canManageAccess}
        showModeSelector={false}
        primaryOwnerUserId={value.primary_owner_user_id}
        principals={principals}
        subjects={subjects}
        sharingScope="branch"
        sessionSharingWorkspaceEnabled={sessionSharingWorkspaceEnabled}
      />
    </Flex>
  );
};
