import type {
  BranchCapabilityPolicyDraft,
  CapabilityPolicyDraft,
  CapabilityPolicyPrincipalDescriptor,
  UserID,
} from '@agor/core/types';
import { CAPABILITY_POLICY_SCHEMA_VERSION } from '@agor/core/types';
import { ApartmentOutlined, EditOutlined } from '@ant-design/icons';
import { Alert, Button, Descriptions, Divider, Flex, Segmented, Typography, theme } from 'antd';
import { useState } from 'react';
import { CapabilityPolicyEditor } from './CapabilityPolicyEditor';
import { ImmutablePrimaryOwner } from './ImmutablePrimaryOwner';
import { BRANCH_ACCESS_EDITOR_CONTEXT } from './policyEditorModel';
import type { PrototypeAccessSubject } from './prototypeEffectiveAccess';

interface BranchCapabilityPolicyFormProps {
  value: BranchCapabilityPolicyDraft;
  onChange: (value: BranchCapabilityPolicyDraft) => void;
  principals: CapabilityPolicyPrincipalDescriptor[];
  subjects: PrototypeAccessSubject[];
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

export const BranchCapabilityPolicyForm: React.FC<BranchCapabilityPolicyFormProps> = ({
  value,
  onChange,
  principals,
  subjects,
}) => {
  const { token } = theme.useToken();
  const [confirmInherit, setConfirmInherit] = useState(false);
  const owner = findUserDescriptor(principals, value.primary_owner_user_id);
  const inheritedPolicy = value.inherited_policy ?? privateBranchPolicy();
  const effectivePolicy =
    value.binding_mode === 'override'
      ? (value.override_policy ?? structuredClone(inheritedPolicy))
      : inheritedPolicy;

  const setBinding = (binding: 'inherit' | 'override') => {
    if (binding === value.binding_mode) return;
    if (binding === 'inherit' && value.override_policy) {
      setConfirmInherit(true);
      return;
    }
    onChange({
      ...value,
      binding_mode: 'override',
      override_policy: structuredClone(inheritedPolicy),
    });
  };

  return (
    <Flex vertical gap={token.paddingMD}>
      <div>
        <Typography.Title level={4} style={{ marginBottom: token.paddingXXS }}>
          Branch permissions
        </Typography.Title>
        <Typography.Text type="secondary">
          Follow the board’s live defaults or use one complete policy for this branch.
        </Typography.Text>
      </div>
      <ImmutablePrimaryOwner owner={owner} resourceLabel="branch" />
      <Divider style={{ marginBlock: 0 }} />

      <Flex vertical gap={token.paddingXXS}>
        <Typography.Text strong>Use permissions from</Typography.Text>
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
            ? 'Inherited access follows future changes to the board template.'
            : 'This complete override replaces the board template.'}
        </Typography.Text>
      </Flex>
      {confirmInherit && (
        <Alert
          type="warning"
          showIcon
          title="Discard this branch override?"
          description="The explicit policy will be removed and this branch will immediately follow the board template in this local prototype."
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
                  onChange({ ...value, binding_mode: 'inherit', override_policy: undefined });
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
                  children: inheritedPolicy.sharing_mode === 'private' ? 'Private' : 'Shared',
                },
                {
                  key: 'entries',
                  label: 'Named entries',
                  children: inheritedPolicy.entries.length,
                },
                {
                  key: 'others',
                  label: 'Others',
                  children:
                    inheritedPolicy.others.preset === 'none'
                      ? 'No access'
                      : inheritedPolicy.others.preset,
                },
              ]}
            />
          </Flex>
          <CapabilityPolicyEditor
            title="Inherited board template"
            description="Read-only here. It updates when a board manager changes the branch defaults."
            value={inheritedPolicy}
            onChange={() => undefined}
            readOnly
            context={BRANCH_ACCESS_EDITOR_CONTEXT}
            primaryOwnerUserId={value.primary_owner_user_id}
            principals={principals}
            subjects={subjects}
          />
        </Flex>
      ) : (
        <Flex vertical gap={token.paddingMD}>
          <Alert
            type="warning"
            showIcon
            icon={<EditOutlined />}
            title="This branch no longer follows board defaults"
            description="The complete policy below replaces the template. Board access remains separate."
          />
          <CapabilityPolicyEditor
            title="Branch access"
            description="Named entries, Others, capabilities, and file access for this branch."
            value={effectivePolicy}
            onChange={(overridePolicy) => onChange({ ...value, override_policy: overridePolicy })}
            context={BRANCH_ACCESS_EDITOR_CONTEXT}
            primaryOwnerUserId={value.primary_owner_user_id}
            principals={principals}
            subjects={subjects}
          />
        </Flex>
      )}
    </Flex>
  );
};
