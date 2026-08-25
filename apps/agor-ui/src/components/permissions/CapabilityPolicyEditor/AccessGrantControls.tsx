import type {
  CapabilityPolicyEntryDraft,
  CapabilityPolicyFsAccess,
  CapabilityPolicyOthersDraft,
  CapabilityPolicyPresetId,
} from '@agor/core/types';
import { LockOutlined } from '@ant-design/icons';
import { Alert, Flex, Segmented, Select, Typography, theme } from 'antd';
import type { CapabilityPolicyEditorContext } from './policyEditorModel';
import {
  applyCapabilityPreset,
  fsAccessDescription,
  fsAccessLabel,
  getCapabilityPreset,
  updateFilesystemAccess,
} from './policyEditorModel';

type GrantValue = CapabilityPolicyEntryDraft | CapabilityPolicyOthersDraft;

interface AccessGrantControlsProps<T extends GrantValue> {
  value: T;
  context: CapabilityPolicyEditorContext;
  onChange: (value: T) => void;
  disabled?: boolean;
  label: string;
}

const fsOptions: Array<{ value: CapabilityPolicyFsAccess; label: string }> = [
  { value: 'none', label: fsAccessLabel.none },
  { value: 'read', label: fsAccessLabel.read },
  { value: 'write', label: fsAccessLabel.write },
];

export function AccessGrantControls<T extends GrantValue>({
  value,
  context,
  onChange,
  disabled,
  label,
}: AccessGrantControlsProps<T>) {
  const { token } = theme.useToken();
  const isManager = value.preset === 'manager';
  const isCollaborator = value.preset === 'collaborator';
  const role = getCapabilityPreset(context, value.preset);
  const hasTerminal = isCollaborator && value.fs_access !== 'none';

  return (
    <Flex vertical gap={token.paddingSM}>
      <Flex gap={token.paddingSM} align="flex-start" wrap>
        <Flex vertical gap={token.paddingXXS} style={{ flex: '1 1 220px', minWidth: 0 }}>
          <Typography.Text strong>Role</Typography.Text>
          <Select<CapabilityPolicyPresetId>
            aria-label={`${label} role`}
            value={value.preset}
            disabled={disabled}
            style={{ width: '100%' }}
            onChange={(preset) => onChange(applyCapabilityPreset(value, context, preset))}
            options={[
              ...context.presets.map((preset) => ({
                value: preset.id,
                label: preset.label,
                title: preset.summary,
                summary: preset.summary,
              })),
              ...(value.preset === 'custom'
                ? [
                    {
                      value: 'custom' as const,
                      label: 'Custom — needs mapping',
                      title: 'This imported combination must be mapped to one role.',
                      summary: 'This imported combination must be mapped to one role.',
                      disabled: true,
                    },
                  ]
                : []),
            ]}
            optionRender={(option) => (
              <Flex vertical gap={2} style={{ paddingBlock: token.paddingXXS }}>
                <Typography.Text strong>{option.label}</Typography.Text>
                <Typography.Text type="secondary" style={{ whiteSpace: 'normal' }}>
                  {option.data.summary}
                </Typography.Text>
              </Flex>
            )}
          />
          <Typography.Text type="secondary">{role?.summary}</Typography.Text>
        </Flex>

        {context.supportsFilesystem && (
          <Flex vertical gap={token.paddingXXS} style={{ flex: '1 1 280px', minWidth: 0 }}>
            <Typography.Text strong>File access</Typography.Text>
            <Segmented<CapabilityPolicyFsAccess>
              aria-label={`${label} file access`}
              block
              value={value.fs_access}
              disabled={disabled || value.preset === 'none'}
              options={fsOptions}
              onChange={(fsAccess) => onChange(updateFilesystemAccess(value, context, fsAccess))}
            />
            <Typography.Text type="secondary">
              {fsAccessDescription[value.fs_access]}
            </Typography.Text>
          </Flex>
        )}
      </Flex>

      {value.preset === 'custom' && (
        <Alert
          type="warning"
          showIcon
          title="Choose a supported role"
          description="The simplified form does not create custom capability combinations. Select one role to replace this imported value."
        />
      )}

      {context.kind === 'branch_access' && isManager && (
        <Typography.Text type="secondary">
          <LockOutlined aria-hidden /> Manager alone can contain and configure, but cannot prompt,
          execute, or open a terminal. A session owner can grant a separate personal exception
          below.
        </Typography.Text>
      )}
      {context.kind === 'branch_access' && isCollaborator && (
        <Typography.Text type="secondary">
          {hasTerminal
            ? 'Terminal is available as this person because Collaborator is paired with file access.'
            : 'They can work in their own sessions without branch files. Terminal stays unavailable until file access is Read or Write.'}
        </Typography.Text>
      )}
    </Flex>
  );
}
