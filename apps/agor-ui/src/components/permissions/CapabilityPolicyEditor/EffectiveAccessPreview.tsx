import type {
  CapabilityPolicyDraft,
  CapabilityPolicyPrincipalDescriptor,
  UserID,
} from '@agor/core/types';
import { CheckCircleOutlined, StopOutlined } from '@ant-design/icons';
import { Alert, Divider, Empty, Flex, Select, Typography, theme } from 'antd';
import { useMemo, useState } from 'react';
import { Tag } from '@/components/Tag';
import type { EffectiveAccessSubject } from './effectiveAccessPreviewModel';
import { resolveEffectiveAccessPreview } from './effectiveAccessPreviewModel';
import { PrincipalIdentity } from './PrincipalIdentity';
import type { CapabilityPolicyEditorContext } from './policyEditorModel';
import { fsAccessLabel, selectedCapabilityControlGroupLabels } from './policyEditorModel';

interface EffectiveAccessPreviewProps {
  policy: CapabilityPolicyDraft;
  primaryOwnerUserId: UserID;
  principals: CapabilityPolicyPrincipalDescriptor[];
  subjects: EffectiveAccessSubject[];
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
        ? resolveEffectiveAccessPreview({
            policy,
            primaryOwnerUserId,
            subject,
            principals,
          })
        : null,
    [policy, primaryOwnerUserId, subject, principals]
  );
  const effectiveGroupLabels = useMemo(
    () =>
      effective
        ? selectedCapabilityControlGroupLabels(context, effective.capabilities)
        : ([] as string[]),
    [context, effective]
  );
  const canPromptOrExecute = effective?.capabilities.some((capability) =>
    ['sessions.create', 'sessions.prompt_own', 'terminal.open'].includes(capability)
  );
  const terminalAvailable = effective?.capabilities.includes('terminal.open');

  return (
    <Flex
      vertical
      gap={token.paddingSM}
      aria-label="Effective-access preview for sample principals"
    >
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
            notFoundContent={<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No people" />}
          />

          <div aria-live="polite">
            <PrincipalIdentity descriptor={subject.user} compact />
            <Divider style={{ marginBlock: token.paddingSM }} />
            {effective?.deniedReason ? (
              <Alert
                type="warning"
                showIcon
                icon={<StopOutlined />}
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
                      ? 'No person or group entry matched.'
                      : effective?.sources[0]?.kind === 'user'
                        ? 'Direct entry overrides groups and Others.'
                        : effective?.sources.length === 1
                          ? 'One group matched.'
                          : 'Matching groups combine; strongest file access applies.'}
                  </Typography.Text>
                </Flex>

                <Flex vertical gap={token.paddingXXS}>
                  <Typography.Text strong>Effective access</Typography.Text>
                  <Flex gap={token.paddingXXS} wrap>
                    {effectiveGroupLabels.length ? (
                      effectiveGroupLabels.map((label) => (
                        <Tag icon={<CheckCircleOutlined />} color="green" key={label}>
                          {label}
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
                    {terminalAvailable && <Tag color="purple">Terminal available</Tag>}
                  </Flex>
                </Flex>

                {context.kind === 'branch_access' && !canPromptOrExecute && (
                  <Alert
                    type="info"
                    showIcon
                    description="Management and file access do not grant prompting, terminal access, or another person’s home."
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
  );
};
