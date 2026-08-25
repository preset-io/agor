import type {
  CapabilityPolicyDraft,
  CapabilityPolicyPrincipalDescriptor,
  UserID,
} from '@agor/core/types';
import { CheckCircleOutlined, EyeOutlined, StopOutlined } from '@ant-design/icons';
import { Alert, Card, Divider, Empty, Flex, Select, Typography, theme } from 'antd';
import { useMemo, useState } from 'react';
import { Tag } from '@/components/Tag';
import { PrincipalIdentity } from './PrincipalIdentity';
import type { CapabilityPolicyEditorContext } from './policyEditorModel';
import { fsAccessLabel } from './policyEditorModel';
import type { PrototypeAccessSubject } from './prototypeEffectiveAccess';
import { resolvePrototypeEffectiveAccess } from './prototypeEffectiveAccess';

interface EffectiveAccessPreviewProps {
  policy: CapabilityPolicyDraft;
  primaryOwnerUserId: UserID;
  principals: CapabilityPolicyPrincipalDescriptor[];
  subjects: PrototypeAccessSubject[];
  context: CapabilityPolicyEditorContext;
}

export const EffectiveAccessPreview: React.FC<EffectiveAccessPreviewProps> = ({
  policy,
  primaryOwnerUserId,
  principals,
  subjects,
  context,
}) => {
  const { token } = theme.useToken();
  const [subjectId, setSubjectId] = useState<UserID>(
    subjects.find((subject) => subject.user.principal.user_id !== primaryOwnerUserId)?.user
      .principal.user_id ?? subjects[0]?.user.principal.user_id
  );
  const subject =
    subjects.find((candidate) => candidate.user.principal.user_id === subjectId) ?? subjects[0];
  const effective = useMemo(
    () =>
      subject
        ? resolvePrototypeEffectiveAccess({
            policy,
            primaryOwnerUserId,
            subject,
            principals,
          })
        : null,
    [policy, primaryOwnerUserId, subject, principals]
  );
  const labelByCapability = useMemo(
    () => new Map(context.capabilities.map((capability) => [capability.value, capability.label])),
    [context.capabilities]
  );
  const canPromptOrExecute = effective?.capabilities.some((capability) =>
    ['sessions.create', 'sessions.prompt_own', 'terminal.open'].includes(capability)
  );

  return (
    <Card
      size="small"
      title={
        <Flex align="center" gap={token.paddingXS} wrap>
          <EyeOutlined aria-hidden />
          <span>Effective-access preview</span>
          <Tag color="purple">Read only</Tag>
        </Flex>
      }
      aria-label="Effective-access preview for sample principals"
    >
      <Flex vertical gap={token.paddingSM}>
        <Typography.Text type="secondary">
          Explore proposed outcomes using local fixture identities. This preview does not authorize
          any product request.
        </Typography.Text>
        {subject ? (
          <>
            <Select<UserID>
              showSearch
              aria-label="Preview effective access for"
              value={subject.user.principal.user_id}
              onChange={setSubjectId}
              optionFilterProp="searchText"
              style={{ width: '100%' }}
              options={subjects.map((candidate) => ({
                value: candidate.user.principal.user_id,
                label: candidate.user.display_name,
                searchText: `${candidate.user.display_name} ${candidate.user.secondary_label ?? ''}`,
                descriptor: candidate.user,
              }))}
              optionRender={(option) => (
                <PrincipalIdentity descriptor={option.data.descriptor} compact />
              )}
              notFoundContent={
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No people" />
              }
            />

            <div aria-live="polite">
              <PrincipalIdentity descriptor={subject.user} compact />
              <Divider style={{ marginBlock: token.paddingSM }} />
              {effective?.deniedReason ? (
                <Alert
                  type="warning"
                  showIcon
                  icon={<StopOutlined />}
                  title="No effective access"
                  description={effective.deniedReason}
                />
              ) : (
                <Flex vertical gap={token.paddingSM}>
                  <Flex vertical gap={token.paddingXXS}>
                    <Typography.Text strong>Matched source</Typography.Text>
                    <Flex gap={token.paddingXXS} wrap>
                      {effective?.sources.map((source) => (
                        <Tag key={source.key} color={source.kind === 'others' ? 'gold' : 'blue'}>
                          {source.label}
                        </Tag>
                      ))}
                    </Flex>
                    <Typography.Text type="secondary">
                      {effective?.usedOthers
                        ? 'No active direct or group entry matched, so the Others fallback applies.'
                        : effective?.sources.length === 1
                          ? 'One explicit source matched.'
                          : 'Overlapping direct and group entries combine by capability union; filesystem access uses the strongest matching level.'}
                    </Typography.Text>
                  </Flex>

                  <Flex vertical gap={token.paddingXXS}>
                    <Typography.Text strong>Effective capabilities</Typography.Text>
                    <Flex gap={token.paddingXXS} wrap>
                      {effective?.capabilities.length ? (
                        effective.capabilities.map((capability) => (
                          <Tag icon={<CheckCircleOutlined />} color="green" key={capability}>
                            {labelByCapability.get(capability) ?? capability}
                          </Tag>
                        ))
                      ) : (
                        <Tag>No capabilities</Tag>
                      )}
                      {context.supportsFilesystem && (
                        <Tag color={effective?.fsAccess === 'write' ? 'volcano' : 'cyan'}>
                          {fsAccessLabel[effective?.fsAccess ?? 'none']}
                        </Tag>
                      )}
                    </Flex>
                  </Flex>

                  {context.kind === 'branch_access' && !canPromptOrExecute && (
                    <Alert
                      type="info"
                      showIcon
                      title="No prompt / execute authority"
                      description="View, management, and filesystem capabilities do not silently grant execution or another person’s credential context."
                    />
                  )}
                </Flex>
              )}
            </div>
          </>
        ) : (
          <Empty description="No sample principals are available" />
        )}
      </Flex>
    </Card>
  );
};
