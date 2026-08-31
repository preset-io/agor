import type {
  CapabilityPolicyDraft,
  CapabilityPolicyEntryDraft,
  CapabilityPolicyOthersDraft,
  CapabilityPolicyPrincipalDescriptor,
  UserID,
} from '@agor/core/types';
import { capabilityPolicyPrincipalKey, validateCapabilityPolicyDraft } from '@agor/core/types';
import {
  CloseOutlined,
  DeleteOutlined,
  EyeOutlined,
  GlobalOutlined,
  InfoCircleOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import type { TableColumnsType } from 'antd';
import {
  Alert,
  Button,
  Card,
  Flex,
  Grid,
  Popconfirm,
  Table,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { useMemo, useState } from 'react';
import { Tag } from '@/components/Tag';
import { AccessGrantControls } from './AccessGrantControls';
import { makeCapabilityPolicyDraftId } from './draftId';
import { EffectiveAccessPreview } from './EffectiveAccessPreview';
import type { EffectiveAccessSubject } from './effectiveAccessPreviewModel';
import { PolicyModeSelector } from './PolicyModeSelector';
import { PrincipalEntryPicker } from './PrincipalEntryPicker';
import { PrincipalIdentity } from './PrincipalIdentity';
import type { CapabilityPolicyEditorContext } from './policyEditorModel';
import {
  capabilityPolicyHasAudience,
  makePrivatePolicy,
  makeSharedClosedPolicy,
} from './policyEditorModel';

interface CapabilityPolicyEditorProps {
  title: string;
  description?: React.ReactNode;
  value: CapabilityPolicyDraft;
  onChange: (value: CapabilityPolicyDraft) => void;
  context: CapabilityPolicyEditorContext;
  primaryOwnerUserId: UserID;
  principals: CapabilityPolicyPrincipalDescriptor[];
  subjects: EffectiveAccessSubject[];
  readOnly?: boolean;
  showModeSelector?: boolean;
}

type AccessListRow =
  | { key: string; kind: 'entry'; entry: CapabilityPolicyEntryDraft; index: number }
  | { key: 'new-entry'; kind: 'new' }
  | { key: 'others'; kind: 'others' };

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
  showModeSelector = true,
}) => {
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const [confirmPrivate, setConfirmPrivate] = useState(false);
  const [addingEntry, setAddingEntry] = useState(false);
  const [showEffectiveAccess, setShowEffectiveAccess] = useState(false);
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
  const rows = useMemo<AccessListRow[]>(
    () => [
      ...value.entries.map((entry, index) => ({
        key: entry.entry_id,
        kind: 'entry' as const,
        entry,
        index,
      })),
      ...(addingEntry ? [{ key: 'new-entry' as const, kind: 'new' as const }] : []),
      { key: 'others', kind: 'others' as const },
    ],
    [addingEntry, value.entries]
  );

  const setSharingMode = (mode: 'private' | 'shared') => {
    if (mode === value.sharing_mode) return;
    if (mode === 'private' && capabilityPolicyHasAudience(value)) {
      setConfirmPrivate(true);
      return;
    }
    setAddingEntry(false);
    onChange(mode === 'private' ? makePrivatePolicy(value) : makeSharedClosedPolicy(value));
  };

  const addPrincipal = (descriptor: CapabilityPolicyPrincipalDescriptor) => {
    const principalKey = capabilityPolicyPrincipalKey(descriptor.principal);
    if (descriptor.status !== 'active' || usedKeys.has(principalKey)) return;
    const entry: CapabilityPolicyEntryDraft = {
      entry_id: makeCapabilityPolicyDraftId(),
      principal: descriptor.principal,
      preset: 'none',
      capabilities: [],
      fs_access: 'none',
    };
    onChange({ ...value, entries: [...value.entries, entry] });
    setAddingEntry(false);
  };

  const updateEntry = (index: number, entry: CapabilityPolicyEntryDraft) => {
    onChange({
      ...value,
      entries: value.entries.map((candidate, candidateIndex) =>
        candidateIndex === index ? entry : candidate
      ),
    });
  };

  const rowDescriptor = (row: AccessListRow) =>
    row.kind === 'entry'
      ? descriptorByKey.get(capabilityPolicyPrincipalKey(row.entry.principal))
      : undefined;

  const rowLabel = (row: AccessListRow) =>
    rowDescriptor(row)?.display_name ??
    (row.kind === 'entry'
      ? 'Unavailable principal'
      : row.kind === 'new'
        ? 'New access entry'
        : 'Others fallback');

  const renderPrincipal = (row: AccessListRow) => {
    const descriptor = rowDescriptor(row);
    if (row.kind === 'entry') return <PrincipalIdentity descriptor={descriptor} compact />;
    if (row.kind === 'new') {
      return (
        <PrincipalEntryPicker
          principals={availablePrincipals}
          onAdd={addPrincipal}
          ariaLabel={`Select one person or group for ${title}`}
          placeholder="Select user or group"
          autoFocus
          showPrefix={false}
        />
      );
    }
    return (
      <Flex vertical gap={token.paddingXXS}>
        <Flex align="center" gap={token.paddingXS} wrap>
          <GlobalOutlined aria-hidden />
          <Typography.Text strong>Others</Typography.Text>
          <Tag color="gold">Fallback</Tag>
          <Tooltip title="Used only when no person or group entry matches. Active workspace members only.">
            <InfoCircleOutlined aria-label="Others fallback details" />
          </Tooltip>
        </Flex>
        <Typography.Text type="secondary">Unmatched active members</Typography.Text>
      </Flex>
    );
  };

  const renderControls = (
    row: AccessListRow,
    compact: boolean,
    field: 'all' | 'role' | 'filesystem' = 'all'
  ) => {
    if (row.kind === 'new') {
      if (field === 'filesystem') return <Typography.Text type="secondary">—</Typography.Text>;
      if (field === 'all') return null;
      return <Typography.Text type="secondary">Choose a user or group</Typography.Text>;
    }
    const entry = row.kind === 'entry' ? row.entry : undefined;
    const descriptor = rowDescriptor(row);
    return (
      <AccessGrantControls
        value={entry ?? value.others}
        context={context}
        compact={compact}
        field={field}
        disabled={readOnly || (entry ? descriptor?.status !== 'active' : false)}
        label={rowLabel(row)}
        onChange={(grant) => {
          if (row.kind === 'entry') {
            updateEntry(row.index, grant as CapabilityPolicyEntryDraft);
          } else {
            onChange({
              ...value,
              others: grant as CapabilityPolicyOthersDraft,
            });
          }
        }}
      />
    );
  };

  const renderRemove = (row: AccessListRow) => {
    if (readOnly || row.kind === 'others') return null;
    if (row.kind === 'new') {
      return (
        <Button
          type="text"
          icon={<CloseOutlined />}
          aria-label="Cancel new access entry"
          onClick={() => setAddingEntry(false)}
        />
      );
    }
    const label = rowLabel(row);
    return (
      <Popconfirm
        title={`Remove ${label}?`}
        okText="Remove entry"
        okButtonProps={{ danger: true }}
        onConfirm={() =>
          onChange({
            ...value,
            entries: value.entries.filter((_, candidateIndex) => candidateIndex !== row.index),
          })
        }
      >
        <Button
          danger
          type="text"
          icon={<DeleteOutlined />}
          aria-label={`Remove access entry for ${label}`}
        />
      </Popconfirm>
    );
  };

  const roleHeader = (
    <Flex align="center" gap={token.paddingXXS}>
      <Typography.Text strong>Role</Typography.Text>
      <Tooltip title="Roles are cumulative. Open a role menu for details.">
        <InfoCircleOutlined aria-label="Role column details" />
      </Tooltip>
    </Flex>
  );

  const filesystemHeader = (
    <Flex align="center" gap={token.paddingXXS}>
      <Typography.Text strong>File access</Typography.Text>
      <Tooltip title="Controls branch file mounts.">
        <InfoCircleOutlined aria-label="File access column details" />
      </Tooltip>
    </Flex>
  );

  const columns: TableColumnsType<AccessListRow> = screens.md
    ? [
        {
          key: 'principal',
          title: 'Person or group',
          width: 230,
          render: (_, row) => (
            <Flex align="center" justify="space-between" gap={token.paddingXS}>
              <div style={{ flex: 1, minWidth: 0 }}>{renderPrincipal(row)}</div>
              {renderRemove(row)}
            </Flex>
          ),
        },
        {
          key: 'role',
          title: roleHeader,
          width: context.supportsFilesystem ? 230 : undefined,
          render: (_, row) => renderControls(row, true, 'role'),
        },
        ...(context.supportsFilesystem
          ? [
              {
                key: 'filesystem',
                title: filesystemHeader,
                width: 150,
                render: (_: unknown, row: AccessListRow) => renderControls(row, true, 'filesystem'),
              },
            ]
          : []),
      ]
    : [
        {
          key: 'entry',
          render: (_, row) => (
            <Flex vertical gap={token.paddingSM}>
              <Flex align="center" justify="space-between" gap={token.paddingSM}>
                <div style={{ flex: 1, minWidth: 0 }}>{renderPrincipal(row)}</div>
                {renderRemove(row)}
              </Flex>
              {renderControls(row, false)}
            </Flex>
          ),
        },
      ];

  return (
    <Flex vertical gap={token.paddingMD}>
      <Flex vertical gap={token.paddingXXS}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        {description && <Typography.Text type="secondary">{description}</Typography.Text>}
      </Flex>

      {showModeSelector && (
        <PolicyModeSelector
          mode="direct"
          title="Sharing"
          ariaLabel={`${title} sharing mode`}
          value={value.sharing_mode}
          disabled={readOnly}
          descriptions={{
            private: context.privateDescription,
            shared: context.sharedDescription,
          }}
          onChange={(mode) => {
            if (mode !== 'inherit') setSharingMode(mode);
          }}
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
                onClick={() => {
                  onChange(makePrivatePolicy(value));
                  setConfirmPrivate(false);
                  setAddingEntry(false);
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

      {value.sharing_mode === 'shared' ? (
        <Flex vertical gap={token.paddingSM}>
          <Flex justify="space-between" align="center" gap={token.paddingSM} wrap>
            <Typography.Text strong>Access entries</Typography.Text>
            {!readOnly && (
              <Button
                icon={<PlusOutlined aria-hidden />}
                disabled={addingEntry || availablePrincipals.length === 0}
                onClick={() => setAddingEntry(true)}
              >
                Add user/group
              </Button>
            )}
          </Flex>
          <Table<AccessListRow>
            size="small"
            bordered
            rowKey="key"
            dataSource={rows}
            columns={columns}
            pagination={false}
            showHeader={!!screens.md}
            tableLayout="fixed"
          />
        </Flex>
      ) : null}

      {subjects.length > 0 && (
        <Flex vertical align="flex-start" gap={token.paddingXS}>
          <Button
            type="link"
            size="small"
            icon={<EyeOutlined aria-hidden />}
            style={{ paddingInline: 0 }}
            aria-expanded={showEffectiveAccess}
            onClick={() => setShowEffectiveAccess((visible) => !visible)}
          >
            {showEffectiveAccess ? 'Hide effective access' : 'Check effective access'}
          </Button>
          {showEffectiveAccess && (
            <Card size="small" style={{ width: '100%' }}>
              <EffectiveAccessPreview
                policy={value}
                primaryOwnerUserId={primaryOwnerUserId}
                principals={principals}
                subjects={subjects}
                context={context}
              />
            </Card>
          )}
        </Flex>
      )}
    </Flex>
  );
};
