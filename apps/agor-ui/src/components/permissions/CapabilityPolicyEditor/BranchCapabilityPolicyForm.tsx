import type {
  BranchCapabilityPolicyDraft,
  CapabilityPolicyDraft,
  CapabilityPolicyPrincipalDescriptor,
  UserID,
} from '@agor/core/types';
import { CAPABILITY_POLICY_SCHEMA_VERSION } from '@agor/core/types';
import { ApartmentOutlined, EditOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Descriptions, Flex, Radio, Typography, theme } from 'antd';
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
    <Flex vertical gap={token.paddingLG}>
      <div>
        <Typography.Title level={3} style={{ marginBottom: token.paddingXXS }}>
          Branch permissions
        </Typography.Title>
        <Typography.Text type="secondary">
          Keep this branch aligned to its board’s live defaults or replace them with one complete
          branch policy.
        </Typography.Text>
      </div>
      <ImmutablePrimaryOwner owner={owner} resourceLabel="branch" />

      <Card title="Policy binding">
        <Flex vertical gap={token.paddingSM}>
          <Radio.Group
            aria-label="Branch policy binding"
            value={value.binding_mode}
            onChange={(event) => setBinding(event.target.value)}
            options={[
              {
                value: 'inherit',
                label: 'Inherit board defaults — follows future template changes',
              },
              {
                value: 'override',
                label: 'Override for this branch — complete independent policy',
              },
            ]}
          />
          {confirmInherit && (
            <Alert
              type="warning"
              showIcon
              title="Discard this branch override?"
              description="The explicit branch policy will be removed and access will immediately follow the board’s live template in this local prototype."
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
        </Flex>
      </Card>

      {value.binding_mode === 'inherit' ? (
        <>
          <Card
            title={
              <Flex align="center" gap={token.paddingXS}>
                <ApartmentOutlined aria-hidden />
                Inherited summary
              </Flex>
            }
          >
            <Descriptions
              size="small"
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
                  label: 'Others fallback',
                  children:
                    inheritedPolicy.others.preset === 'none'
                      ? 'No access'
                      : inheritedPolicy.others.preset,
                },
              ]}
            />
          </Card>
          <CapabilityPolicyEditor
            title="Inherited board template"
            description="Read-only here. It updates when a board manager changes the live branch defaults."
            value={inheritedPolicy}
            onChange={() => undefined}
            readOnly
            context={BRANCH_ACCESS_EDITOR_CONTEXT}
            primaryOwnerUserId={value.primary_owner_user_id}
            principals={principals}
            subjects={subjects}
          />
        </>
      ) : (
        <>
          <Alert
            type="warning"
            showIcon
            icon={<EditOutlined />}
            title="This branch no longer follows board defaults"
            description="All access comes from the explicit policy below. Board access remains a separate check."
          />
          <CapabilityPolicyEditor
            title="Explicit branch override"
            description="A complete branch policy. This replaces—not layers on top of—the board template."
            value={effectivePolicy}
            onChange={(overridePolicy) => onChange({ ...value, override_policy: overridePolicy })}
            context={BRANCH_ACCESS_EDITOR_CONTEXT}
            primaryOwnerUserId={value.primary_owner_user_id}
            principals={principals}
            subjects={subjects}
          />
        </>
      )}
    </Flex>
  );
};
