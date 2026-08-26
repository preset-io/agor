import type {
  BranchCapabilityPolicyDraft,
  BranchPermissionConfigDraft,
  CapabilityPolicyDraft,
  CapabilityPolicyPrincipalDescriptor,
  UserID,
} from '@agor/core/types';
import { CAPABILITY_POLICY_SCHEMA_VERSION } from '@agor/core/types';
import { ApartmentOutlined } from '@ant-design/icons';
import { Alert, Button, Descriptions, Divider, Flex, Segmented, Typography, theme } from 'antd';
import { useState } from 'react';
import { BranchPermissionConfigEditor } from './BranchPermissionConfigEditor';
import { ImmutablePrimaryOwner } from './ImmutablePrimaryOwner';
import type { PrototypeAccessSubject } from './prototypeEffectiveAccess';

interface BranchCapabilityPolicyFormProps {
  value: BranchCapabilityPolicyDraft;
  onChange: (value: BranchCapabilityPolicyDraft) => void;
  principals: CapabilityPolicyPrincipalDescriptor[];
  subjects: PrototypeAccessSubject[];
  currentUserId: UserID;
  personalSessionSharingWorkspaceEnabled?: boolean;
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

const privateBranchConfig = (currentUserId: UserID): BranchPermissionConfigDraft => ({
  access: privateBranchPolicy(),
  session_sharing: {
    owner_rules: [
      {
        session_owner_user_id: currentUserId,
        enabled: false,
        grantees: [],
      },
    ],
  },
});

export const BranchCapabilityPolicyForm: React.FC<BranchCapabilityPolicyFormProps> = ({
  value,
  onChange,
  principals,
  subjects,
  currentUserId,
  personalSessionSharingWorkspaceEnabled = true,
}) => {
  const { token } = theme.useToken();
  const [confirmInherit, setConfirmInherit] = useState(false);
  const owner = findUserDescriptor(principals, value.primary_owner_user_id);
  const inheritedConfig = value.inherited_config ?? privateBranchConfig(currentUserId);
  const effectiveConfig =
    value.binding_mode === 'override'
      ? (value.override_config ?? structuredClone(inheritedConfig))
      : inheritedConfig;

  const setBinding = (binding: 'inherit' | 'override') => {
    if (binding === value.binding_mode) return;
    if (binding === 'inherit' && value.override_config) {
      setConfirmInherit(true);
      return;
    }
    onChange({
      ...value,
      binding_mode: 'override',
      override_config: structuredClone(inheritedConfig),
    });
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

      <Flex vertical gap={token.paddingXXS}>
        <Typography.Text strong>Use settings from</Typography.Text>
        <Segmented<'inherit' | 'override'>
          aria-label="Branch policy binding"
          block
          value={value.binding_mode}
          onChange={setBinding}
          options={[
            { value: 'inherit', label: 'Board defaults' },
            { value: 'override', label: 'This branch' },
          ]}
        />
        <Typography.Text type="secondary">
          {value.binding_mode === 'inherit'
            ? 'Access, files, and session sharing update with the board defaults.'
            : 'Access, files, and session sharing are configured for this branch.'}
        </Typography.Text>
      </Flex>
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

      {value.binding_mode === 'inherit' ? (
        <Flex vertical gap={token.paddingMD}>
          <Flex vertical gap={token.paddingXS}>
            <Typography.Text strong>
              <ApartmentOutlined aria-hidden /> Inherited summary
            </Typography.Text>
            <Descriptions
              size="small"
              bordered
              column={{ xs: 1, sm: 2 }}
              items={[
                { key: 'source', label: 'Source', children: 'Board live branch defaults' },
                {
                  key: 'mode',
                  label: 'Sharing',
                  children:
                    inheritedConfig.access.sharing_mode === 'private' ? 'Private' : 'Shared',
                },
                {
                  key: 'entries',
                  label: 'Named entries',
                  children: inheritedConfig.access.entries.length,
                },
                {
                  key: 'others',
                  label: 'Others',
                  children:
                    inheritedConfig.access.others.preset === 'none'
                      ? 'No access'
                      : inheritedConfig.access.others.preset,
                },
              ]}
            />
          </Flex>
          <BranchPermissionConfigEditor
            accessTitle="Inherited board template"
            value={inheritedConfig}
            onChange={() => undefined}
            readOnly
            primaryOwnerUserId={value.primary_owner_user_id}
            currentUserId={currentUserId}
            principals={principals}
            subjects={subjects}
            sharingScope="branch"
            personalSessionSharingWorkspaceEnabled={personalSessionSharingWorkspaceEnabled}
          />
        </Flex>
      ) : (
        <Flex vertical gap={token.paddingMD}>
          <BranchPermissionConfigEditor
            accessTitle="Branch access"
            value={effectiveConfig}
            onChange={(overrideConfig) => onChange({ ...value, override_config: overrideConfig })}
            primaryOwnerUserId={value.primary_owner_user_id}
            currentUserId={currentUserId}
            principals={principals}
            subjects={subjects}
            sharingScope="branch"
            personalSessionSharingWorkspaceEnabled={personalSessionSharingWorkspaceEnabled}
          />
        </Flex>
      )}
    </Flex>
  );
};
