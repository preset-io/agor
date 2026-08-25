import type {
  CapabilityPolicyDraft,
  CapabilityPolicyEntryDraft,
  CapabilityPolicyPrincipalDescriptor,
  UserID,
  UUID,
} from '@agor/core/types';
import { capabilityPolicyPrincipalKey, validateCapabilityPolicyDraft } from '@agor/core/types';
import {
  PlusOutlined,
  SafetyCertificateOutlined,
  SafetyOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { Alert, Button, Card, Empty, Flex, Radio, Select, Typography, theme } from 'antd';
import { useMemo, useState } from 'react';
import { EffectiveAccessPreview } from './EffectiveAccessPreview';
import { OthersFallbackCard } from './OthersFallbackCard';
import { PolicyEntryCard } from './PolicyEntryCard';
import { PrincipalIdentity } from './PrincipalIdentity';
import type { CapabilityPolicyEditorContext } from './policyEditorModel';
import { makePrivatePolicy, makeSharedClosedPolicy } from './policyEditorModel';
import type { PrototypeAccessSubject } from './prototypeEffectiveAccess';

interface CapabilityPolicyEditorProps {
  title: string;
  description: React.ReactNode;
  value: CapabilityPolicyDraft;
  onChange: (value: CapabilityPolicyDraft) => void;
  context: CapabilityPolicyEditorContext;
  primaryOwnerUserId: UserID;
  principals: CapabilityPolicyPrincipalDescriptor[];
  subjects: PrototypeAccessSubject[];
  readOnly?: boolean;
}

function makeEntryId(): UUID {
  return crypto.randomUUID() as UUID;
}

export const CapabilityPolicyEditor: React.FC<CapabilityPolicyEditorProps> = ({
  title,
  description,
  value,
  onChange,
  context,
  primaryOwnerUserId,
  principals,
  subjects,
  readOnly,
}) => {
  const { token } = theme.useToken();
  const [principalToAdd, setPrincipalToAdd] = useState<string>();
  const [confirmPrivate, setConfirmPrivate] = useState(false);
  const issues = validateCapabilityPolicyDraft(value);
  const descriptorByKey = useMemo(
    () =>
      new Map(
        principals.map((principal) => [
          capabilityPolicyPrincipalKey(principal.principal),
          principal,
        ])
      ),
    [principals]
  );
  const usedKeys = useMemo(
    () => new Set(value.entries.map((entry) => capabilityPolicyPrincipalKey(entry.principal))),
    [value.entries]
  );
  const availablePrincipals = principals.filter((principal) => {
    if (principal.status !== 'active') return false;
    if (
      principal.principal.principal_type === 'user' &&
      principal.principal.user_id === primaryOwnerUserId
    ) {
      return false;
    }
    return !usedKeys.has(capabilityPolicyPrincipalKey(principal.principal));
  });

  const setSharingMode = (mode: 'private' | 'shared') => {
    if (mode === value.sharing_mode) return;
    if (mode === 'private' && (value.entries.length > 0 || value.others.capabilities.length > 0)) {
      setConfirmPrivate(true);
      return;
    }
    onChange(mode === 'private' ? makePrivatePolicy(value) : makeSharedClosedPolicy(value));
  };

  const addPrincipal = () => {
    if (!principalToAdd) return;
    const descriptor = descriptorByKey.get(principalToAdd);
    if (descriptor?.status !== 'active' || usedKeys.has(principalToAdd)) return;
    const entry: CapabilityPolicyEntryDraft = {
      entry_id: makeEntryId(),
      principal: descriptor.principal,
      preset: 'none',
      capabilities: [],
      fs_access: 'none',
    };
    onChange({ ...value, entries: [...value.entries, entry] });
    setPrincipalToAdd(undefined);
  };

  const updateEntry = (index: number, entry: CapabilityPolicyEntryDraft) => {
    onChange({
      ...value,
      entries: value.entries.map((candidate, candidateIndex) =>
        candidateIndex === index ? entry : candidate
      ),
    });
  };

  return (
    <Flex vertical gap={token.paddingLG}>
      <Card>
        <Flex vertical gap={token.paddingSM}>
          <div>
            <Typography.Title level={4} style={{ margin: 0 }}>
              {title}
            </Typography.Title>
            <Typography.Text type="secondary">{description}</Typography.Text>
          </div>

          <Radio.Group
            aria-label={`${title} sharing mode`}
            value={value.sharing_mode}
            disabled={readOnly}
            onChange={(event) => setSharingMode(event.target.value)}
            options={[
              {
                value: 'private',
                label: `Private — ${context.privateDescription}`,
              },
              {
                value: 'shared',
                label: `Shared — ${context.sharedDescription}`,
              },
            ]}
          />
          <Typography.Text type="secondary">
            In the target model, changing Private / Shared is reserved for the immutable primary
            owner. Managers may edit named entries only while the resource is shared.
          </Typography.Text>

          {readOnly && (
            <Alert
              type="info"
              showIcon
              title="Inherited policy is read only here"
              description="Switch this branch to Override before editing."
            />
          )}

          {confirmPrivate && (
            <Alert
              type="warning"
              showIcon
              title="Make this owner-only?"
              description="All named entries and the Others fallback will be removed from this local draft. This cannot transfer ownership."
              action={
                <Flex gap={token.paddingXS} wrap>
                  <Button size="small" onClick={() => setConfirmPrivate(false)}>
                    Keep shared
                  </Button>
                  <Button
                    size="small"
                    danger
                    type="primary"
                    onClick={() => {
                      onChange(makePrivatePolicy(value));
                      setConfirmPrivate(false);
                    }}
                  >
                    Make private
                  </Button>
                </Flex>
              }
            />
          )}

          {issues.length > 0 && (
            <Alert
              type="error"
              showIcon
              title="Resolve invalid policy combinations"
              description={
                <ul style={{ margin: 0, paddingInlineStart: token.paddingLG }}>
                  {issues.map((issue) => (
                    <li key={`${issue.code}:${issue.entry_id ?? 'policy'}:${issue.message}`}>
                      {issue.message}
                    </li>
                  ))}
                </ul>
              }
            />
          )}

          {context.kind === 'branch_access' && (
            <Flex vertical gap={token.paddingSM}>
              <Alert
                type="info"
                showIcon
                icon={<SafetyOutlined />}
                title="Manage and prompt / execute are independent"
                description="A Manager may contain sessions and manage policy without gaining permission to prompt, run a terminal, or use another person’s home and credentials."
              />
              <Alert
                type="warning"
                showIcon
                icon={<SafetyCertificateOutlined />}
                title="Filesystem grants need an isolation boundary"
                description="The future policy is enforceable in sandbox or reviewed delegated execution. Simple mode is not a filesystem security boundary."
              />
            </Flex>
          )}
        </Flex>
      </Card>

      {value.sharing_mode === 'shared' ? (
        <>
          <Card
            title="Named people and groups"
            extra={
              readOnly ? undefined : (
                <Typography.Text type="secondary">Direct matches</Typography.Text>
              )
            }
          >
            <Flex vertical gap={token.paddingSM}>
              {!readOnly && (
                <Flex gap={token.paddingXS} align="center" wrap>
                  <Select
                    showSearch
                    allowClear
                    aria-label="Search people and groups"
                    placeholder="Search people and groups"
                    prefix={<SearchOutlined />}
                    value={principalToAdd}
                    onChange={setPrincipalToAdd}
                    optionFilterProp="searchText"
                    style={{ flex: '1 1 260px', minWidth: 0 }}
                    options={availablePrincipals.map((principal) => ({
                      value: capabilityPolicyPrincipalKey(principal.principal),
                      label: principal.display_name,
                      searchText: `${principal.display_name} ${principal.secondary_label ?? ''} ${principal.principal.principal_type}`,
                      descriptor: principal,
                    }))}
                    optionRender={(option) => (
                      <PrincipalIdentity descriptor={option.data.descriptor} compact />
                    )}
                    notFoundContent={
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description="No active people or groups available"
                      />
                    }
                  />
                  <Button icon={<PlusOutlined />} disabled={!principalToAdd} onClick={addPrincipal}>
                    Add entry
                  </Button>
                </Flex>
              )}

              {value.entries.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="No named entries. Only the explicit Others fallback can match."
                />
              ) : (
                value.entries.map((entry, index) => (
                  <PolicyEntryCard
                    key={entry.entry_id}
                    value={entry}
                    descriptor={descriptorByKey.get(capabilityPolicyPrincipalKey(entry.principal))}
                    context={context}
                    onChange={(nextEntry) => updateEntry(index, nextEntry)}
                    onRemove={() =>
                      onChange({
                        ...value,
                        entries: value.entries.filter(
                          (_, candidateIndex) => candidateIndex !== index
                        ),
                      })
                    }
                    disabled={readOnly}
                  />
                ))
              )}
            </Flex>
          </Card>

          <OthersFallbackCard
            value={value.others}
            context={context}
            disabled={readOnly}
            onChange={(others) => onChange({ ...value, others })}
          />
        </>
      ) : (
        <Card>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="Private: only the immutable primary owner has access."
          />
        </Card>
      )}

      <EffectiveAccessPreview
        policy={value}
        primaryOwnerUserId={primaryOwnerUserId}
        principals={principals}
        subjects={subjects}
        context={context}
      />
    </Flex>
  );
};
