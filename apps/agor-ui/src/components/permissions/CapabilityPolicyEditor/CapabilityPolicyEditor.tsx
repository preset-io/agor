import type {
  CapabilityPolicyDraft,
  CapabilityPolicyEntryDraft,
  CapabilityPolicyPrincipalDescriptor,
  UserID,
} from '@agor/core/types';
import { capabilityPolicyPrincipalKey, validateCapabilityPolicyDraft } from '@agor/core/types';
import { EyeOutlined, GlobalOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Empty,
  Flex,
  Grid,
  Segmented,
  Typography,
  theme,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { Tag } from '@/components/Tag';
import { EffectiveAccessPreview } from './EffectiveAccessPreview';
import { OthersFallbackCard } from './OthersFallbackCard';
import { PolicyEntryCard } from './PolicyEntryCard';
import { PrincipalEntryPicker } from './PrincipalEntryPicker';
import { PrincipalIdentity } from './PrincipalIdentity';
import type { CapabilityPolicyEditorContext } from './policyEditorModel';
import { fsAccessLabel, makePrivatePolicy, makeSharedClosedPolicy } from './policyEditorModel';
import { makePrototypeDraftId } from './prototypeDraftId';
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

const OTHERS_ENTRY_KEY = 'others';

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
  const screens = Grid.useBreakpoint();
  const [confirmPrivate, setConfirmPrivate] = useState(false);
  const [selectedEntryKey, setSelectedEntryKey] = useState<string>(OTHERS_ENTRY_KEY);
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
  const selectedEntryIndex = value.entries.findIndex(
    (entry) => entry.entry_id === selectedEntryKey
  );
  const selectedEntry = value.entries[selectedEntryIndex];

  useEffect(() => {
    if (
      selectedEntryKey !== OTHERS_ENTRY_KEY &&
      !value.entries.some((entry) => entry.entry_id === selectedEntryKey)
    ) {
      setSelectedEntryKey(OTHERS_ENTRY_KEY);
    }
  }, [selectedEntryKey, value.entries]);

  const presetLabel = (entry: CapabilityPolicyEntryDraft) =>
    context.presets.find((preset) => preset.id === entry.preset)?.label ?? 'Custom';

  const setSharingMode = (mode: 'private' | 'shared') => {
    if (mode === value.sharing_mode) return;
    if (
      mode === 'private' &&
      (value.entries.length > 0 ||
        value.others.capabilities.length > 0 ||
        value.others.fs_access !== 'none')
    ) {
      setConfirmPrivate(true);
      return;
    }
    onChange(mode === 'private' ? makePrivatePolicy(value) : makeSharedClosedPolicy(value));
  };

  const addPrincipal = (descriptor: CapabilityPolicyPrincipalDescriptor) => {
    const principalKey = capabilityPolicyPrincipalKey(descriptor.principal);
    if (descriptor.status !== 'active' || usedKeys.has(principalKey)) return;
    const entry: CapabilityPolicyEntryDraft = {
      entry_id: makePrototypeDraftId(),
      principal: descriptor.principal,
      preset: 'none',
      capabilities: [],
      fs_access: 'none',
    };
    onChange({ ...value, entries: [...value.entries, entry] });
    setSelectedEntryKey(entry.entry_id);
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
    <Flex vertical gap={token.paddingMD}>
      <Flex vertical gap={token.paddingXXS}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        <Typography.Text type="secondary">{description}</Typography.Text>
      </Flex>

      <Flex vertical gap={token.paddingXXS}>
        <Typography.Text strong>Sharing</Typography.Text>
        <Segmented<'private' | 'shared'>
          aria-label={`${title} sharing mode`}
          block
          value={value.sharing_mode}
          disabled={readOnly}
          onChange={setSharingMode}
          options={[
            { value: 'private', label: 'Private' },
            { value: 'shared', label: 'Shared' },
          ]}
        />
        <Typography.Text type="secondary">
          {value.sharing_mode === 'private'
            ? context.privateDescription
            : context.sharedDescription}
        </Typography.Text>
      </Flex>

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
          description="All named entries and Others will be removed from this local draft. Ownership does not change."
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
                  setSelectedEntryKey(OTHERS_ENTRY_KEY);
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
        <Typography.Text type="secondary">
          Each role has one fixed meaning. File access is selected separately; only Collaborator
          with Read or Write file access receives a terminal.
        </Typography.Text>
      )}

      {value.sharing_mode === 'shared' ? (
        <Flex vertical={!screens.md} gap={token.paddingSM} align="stretch">
          <Card
            size="small"
            title="Access entries"
            extra={<Tag>{value.entries.length} entries</Tag>}
            style={{ flex: screens.md ? '0 0 280px' : undefined, minWidth: 0 }}
            styles={{ body: { padding: token.paddingSM } }}
          >
            <Flex vertical gap={token.paddingSM}>
              {!readOnly && (
                <Flex vertical gap={token.paddingXXS}>
                  <PrincipalEntryPicker
                    principals={availablePrincipals}
                    onAdd={addPrincipal}
                    ariaLabel={`Add one person or group to ${title}`}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                    One entry represents one existing person or workspace group. Group membership is
                    managed separately.
                  </Typography.Text>
                </Flex>
              )}

              {value.entries.length === 0 && (
                <Typography.Text type="secondary">
                  No named entries. Add one or configure Others.
                </Typography.Text>
              )}

              {value.entries.map((entry) => {
                const descriptor = descriptorByKey.get(
                  capabilityPolicyPrincipalKey(entry.principal)
                );
                const label = descriptor?.display_name ?? 'Unavailable principal';
                const selected = selectedEntryKey === entry.entry_id;
                return (
                  <Button
                    key={entry.entry_id}
                    block
                    type={selected ? 'default' : 'text'}
                    aria-label={`Edit access for ${label}`}
                    aria-pressed={selected}
                    onClick={() => setSelectedEntryKey(entry.entry_id)}
                    style={{ height: 'auto', padding: token.paddingXS, textAlign: 'start' }}
                  >
                    <Flex vertical gap={token.paddingXXS} style={{ width: '100%', minWidth: 0 }}>
                      <PrincipalIdentity descriptor={descriptor} compact />
                      <Flex gap={token.paddingXXS} wrap>
                        <Tag color="blue">{presetLabel(entry)}</Tag>
                        {context.supportsFilesystem && <Tag>{fsAccessLabel[entry.fs_access]}</Tag>}
                      </Flex>
                    </Flex>
                  </Button>
                );
              })}

              <Button
                block
                type={selectedEntryKey === OTHERS_ENTRY_KEY ? 'default' : 'text'}
                aria-label="Edit Others fallback"
                aria-pressed={selectedEntryKey === OTHERS_ENTRY_KEY}
                onClick={() => setSelectedEntryKey(OTHERS_ENTRY_KEY)}
                style={{ height: 'auto', padding: token.paddingXS, textAlign: 'start' }}
              >
                <Flex vertical gap={token.paddingXXS} style={{ width: '100%', minWidth: 0 }}>
                  <Flex align="center" gap={token.paddingXS}>
                    <GlobalOutlined aria-hidden />
                    <Typography.Text strong>Others</Typography.Text>
                    <Tag color="gold">Fallback</Tag>
                  </Flex>
                  <Typography.Text type="secondary">Unmatched active members only</Typography.Text>
                </Flex>
              </Button>
            </Flex>
          </Card>

          <Card
            size="small"
            title={selectedEntry ? 'Named access' : 'Fallback access'}
            style={{ flex: 1, minWidth: 0 }}
            styles={{ body: { padding: token.paddingSM } }}
          >
            {selectedEntry ? (
              <PolicyEntryCard
                value={selectedEntry}
                descriptor={descriptorByKey.get(
                  capabilityPolicyPrincipalKey(selectedEntry.principal)
                )}
                context={context}
                onChange={(nextEntry) => updateEntry(selectedEntryIndex, nextEntry)}
                onRemove={() => {
                  onChange({
                    ...value,
                    entries: value.entries.filter(
                      (_, candidateIndex) => candidateIndex !== selectedEntryIndex
                    ),
                  });
                  setSelectedEntryKey(OTHERS_ENTRY_KEY);
                }}
                disabled={readOnly}
              />
            ) : (
              <OthersFallbackCard
                value={value.others}
                context={context}
                disabled={readOnly}
                onChange={(others) => onChange({ ...value, others })}
              />
            )}
          </Card>
        </Flex>
      ) : (
        <Card size="small">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="Private: only the immutable primary owner has access."
          />
        </Card>
      )}

      <Collapse
        size="small"
        items={[
          {
            key: 'effective-preview',
            label: (
              <Flex align="center" gap={token.paddingXS} wrap>
                <EyeOutlined aria-hidden />
                <Typography.Text strong>Preview effective access</Typography.Text>
                <Tag color="purple">Read only</Tag>
              </Flex>
            ),
            children: (
              <EffectiveAccessPreview
                policy={value}
                primaryOwnerUserId={primaryOwnerUserId}
                principals={principals}
                subjects={subjects}
                context={context}
              />
            ),
          },
        ]}
      />
    </Flex>
  );
};
