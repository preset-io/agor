import type {
  BranchSessionSharingDraft,
  BranchSessionSharingGrantDraft,
  BranchSessionSharingOwnerRuleDraft,
  CapabilityPolicyPrincipalDescriptor,
  UserID,
} from '@agor/core/types';
import { capabilityPolicyPrincipalKey, validateBranchSessionSharingDraft } from '@agor/core/types';
import { DeleteOutlined, SafetyCertificateOutlined, WarningOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Divider,
  Empty,
  Flex,
  Popconfirm,
  Switch,
  Typography,
  theme,
} from 'antd';
import { Tag } from '@/components/Tag';
import { PrincipalEntryPicker } from './PrincipalEntryPicker';
import { PrincipalIdentity } from './PrincipalIdentity';
import { makePrototypeDraftId } from './prototypeDraftId';

interface PersonalSessionSharingSectionProps {
  value: BranchSessionSharingDraft;
  onChange: (value: BranchSessionSharingDraft) => void;
  currentUserId: UserID;
  principals: CapabilityPolicyPrincipalDescriptor[];
}

const principalDescriptor = (principals: CapabilityPolicyPrincipalDescriptor[], userId: UserID) =>
  principals.find(
    (principal) =>
      principal.principal.principal_type === 'user' && principal.principal.user_id === userId
  );

const makeGrant = (
  principal: CapabilityPolicyPrincipalDescriptor
): BranchSessionSharingGrantDraft => ({
  grant_id: makePrototypeDraftId(),
  principal: principal.principal,
});

export const PersonalSessionSharingSection: React.FC<PersonalSessionSharingSectionProps> = ({
  value,
  onChange,
  currentUserId,
  principals,
}) => {
  const { token } = theme.useToken();
  const descriptorByKey = new Map(
    principals.map((principal) => [capabilityPolicyPrincipalKey(principal.principal), principal])
  );
  const currentUser = principalDescriptor(principals, currentUserId);
  const currentRule = value.owner_rules.find(
    (rule) => rule.session_owner_user_id === currentUserId
  ) ?? {
    session_owner_user_id: currentUserId,
    enabled: false,
    grantees: [],
  };
  const usedKeys = new Set(
    currentRule.grantees.map((grant) => capabilityPolicyPrincipalKey(grant.principal))
  );
  const availablePrincipals = principals.filter((principal) => {
    if (principal.status !== 'active') return false;
    if (
      principal.principal.principal_type === 'user' &&
      principal.principal.user_id === currentUserId
    ) {
      return false;
    }
    return !usedKeys.has(capabilityPolicyPrincipalKey(principal.principal));
  });
  const otherRules = value.owner_rules.filter(
    (rule) =>
      rule.session_owner_user_id !== currentUserId && rule.enabled && rule.grantees.length > 0
  );
  const hasGroupGrant = currentRule.grantees.some(
    (grant) => grant.principal.principal_type === 'group'
  );
  const issues = validateBranchSessionSharingDraft(value);

  const updateCurrentRule = (nextRule: BranchSessionSharingOwnerRuleDraft) => {
    const existingIndex = value.owner_rules.findIndex(
      (rule) => rule.session_owner_user_id === currentUserId
    );
    const ownerRules = [...value.owner_rules];
    if (existingIndex === -1) ownerRules.push(nextRule);
    else ownerRules[existingIndex] = nextRule;
    onChange({ ...value, owner_rules: ownerRules });
  };

  return (
    <Card
      size="small"
      title={
        <Flex align="center" gap={token.paddingXS} wrap>
          <SafetyCertificateOutlined aria-hidden />
          <span>Personal session sharing</span>
          <Tag color="error">High risk</Tag>
        </Flex>
      }
    >
      <Flex vertical gap={token.paddingMD}>
        <Typography.Text type="secondary">
          This is a personal exception, separate from branch roles and board defaults. Each session
          owner controls only who may prompt sessions owned by them.
        </Typography.Text>

        {issues.length > 0 && (
          <Alert
            type="error"
            showIcon
            title="Resolve invalid personal sharing rules"
            description={
              <ul style={{ margin: 0, paddingInlineStart: token.paddingLG }}>
                {issues.map((issue, index) => (
                  <li key={`${issue.code}:${issue.owner_user_id}:${issue.grant_id ?? index}`}>
                    {issue.message}
                  </li>
                ))}
              </ul>
            }
          />
        )}

        <Flex justify="space-between" align="center" gap={token.paddingMD} wrap>
          <Flex vertical gap={token.paddingXXS} style={{ flex: 1, minWidth: 240 }}>
            <Typography.Text strong>Allow others to prompt my sessions</Typography.Text>
            <Typography.Text type="secondary">
              {currentUser?.display_name ?? 'The signed-in user'} is the only person who can change
              this rule. Turning it off removes its entries.
            </Typography.Text>
          </Flex>
          <Switch
            checked={currentRule.enabled}
            aria-label={`Allow others to prompt sessions owned by ${currentUser?.display_name ?? 'me'}`}
            onChange={(enabled) =>
              updateCurrentRule({
                ...currentRule,
                enabled,
                grantees: enabled ? currentRule.grantees : [],
              })
            }
          />
        </Flex>

        {currentRule.enabled && (
          <Flex vertical gap={token.paddingSM}>
            <Alert
              type="error"
              showIcon
              icon={<WarningOutlined />}
              title="Sharing a session means sharing your agent-tool home"
              description="Anyone listed may continue any session you own in this branch. Their prompts run with your agent-tool home and credential context. Agent tools store session state as files in that home, so a delegate may be able to read or modify low-level data from your other sessions. This does not grant a terminal or replace ordinary branch access."
            />

            <Flex vertical gap={token.paddingXXS}>
              <Typography.Text strong>Who may prompt my sessions</Typography.Text>
              <PrincipalEntryPicker
                principals={availablePrincipals}
                ariaLabel="Add one person or group to my session sharing"
                placeholder="Add one trusted person or group"
                onAdd={(principal) =>
                  updateCurrentRule({
                    ...currentRule,
                    grantees: [...currentRule.grantees, makeGrant(principal)],
                  })
                }
              />
              <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                One entry is one existing person or workspace group. This exception is effective
                only while they also retain ordinary access to this branch.
              </Typography.Text>
            </Flex>

            {currentRule.grantees.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="Sharing is on, but nobody is allowed yet."
              />
            ) : (
              <Flex vertical gap={token.paddingXS}>
                {currentRule.grantees.map((grant) => {
                  const descriptor = descriptorByKey.get(
                    capabilityPolicyPrincipalKey(grant.principal)
                  );
                  const label = descriptor?.display_name ?? 'Unavailable principal';
                  return (
                    <Flex
                      key={grant.grant_id}
                      align="center"
                      justify="space-between"
                      gap={token.paddingSM}
                      style={{
                        border: `1px solid ${token.colorBorderSecondary}`,
                        borderRadius: token.borderRadius,
                        padding: token.paddingXS,
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <PrincipalIdentity descriptor={descriptor} compact />
                      </div>
                      <Popconfirm
                        title={`Stop sharing with ${label}?`}
                        description="They will no longer be allowed to prompt sessions you own."
                        okText="Remove sharing"
                        okButtonProps={{ danger: true }}
                        onConfirm={() =>
                          updateCurrentRule({
                            ...currentRule,
                            grantees: currentRule.grantees.filter(
                              (candidate) => candidate.grant_id !== grant.grant_id
                            ),
                          })
                        }
                      >
                        <Button
                          danger
                          type="text"
                          icon={<DeleteOutlined />}
                          aria-label={`Stop sharing my sessions with ${label}`}
                        />
                      </Popconfirm>
                    </Flex>
                  );
                })}
              </Flex>
            )}

            {hasGroupGrant && (
              <Alert
                type="warning"
                showIcon
                title="Group membership changes this high-risk access"
                description="Adding someone to a listed workspace group would let them use this exception without another branch edit."
              />
            )}
          </Flex>
        )}

        <Divider style={{ marginBlock: 0 }} />

        <Flex vertical gap={token.paddingXS}>
          <Flex align="center" gap={token.paddingXS} wrap>
            <Typography.Text strong>Other people’s sharing</Typography.Text>
            <Tag>Read only</Tag>
          </Flex>
          <Typography.Text type="secondary">
            These rules were authored by each session owner. You cannot change them, even if your
            branch role is Manager.
          </Typography.Text>
          {otherRules.length === 0 ? (
            <Typography.Text type="secondary">
              Nobody else currently shares their sessions in this branch.
            </Typography.Text>
          ) : (
            <Flex vertical gap={token.paddingXS}>
              {otherRules.map((rule) => {
                const owner = principalDescriptor(principals, rule.session_owner_user_id);
                return (
                  <Card
                    key={rule.session_owner_user_id}
                    size="small"
                    title={`${owner?.display_name ?? 'Unavailable owner'} shares with`}
                    extra={<Tag>Only they can change</Tag>}
                  >
                    <Flex vertical gap={token.paddingXS}>
                      {rule.grantees.map((grant) => (
                        <PrincipalIdentity
                          key={grant.grant_id}
                          descriptor={descriptorByKey.get(
                            capabilityPolicyPrincipalKey(grant.principal)
                          )}
                          compact
                        />
                      ))}
                    </Flex>
                  </Card>
                );
              })}
            </Flex>
          )}
        </Flex>
      </Flex>
    </Card>
  );
};
