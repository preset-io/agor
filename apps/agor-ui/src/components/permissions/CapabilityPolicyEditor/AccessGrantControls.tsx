import type {
  CapabilityPolicyEntryDraft,
  CapabilityPolicyFsAccess,
  CapabilityPolicyOthersDraft,
  CapabilityPolicyPresetId,
} from '@agor/core/types';
import { LockOutlined } from '@ant-design/icons';
import { Collapse, Flex, Segmented, Select, Typography, theme } from 'antd';
import { Tag } from '@/components/Tag';
import { CapabilitySelection } from './CapabilitySelection';
import type { CapabilityPolicyEditorContext } from './policyEditorModel';
import {
  applyCapabilityPreset,
  fsAccessDescription,
  fsAccessLabel,
  isCapabilityControlGroupSelected,
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
  const canPromptOrExecute = value.capabilities.some((capability) =>
    ['sessions.create', 'sessions.prompt_own', 'terminal.open'].includes(capability)
  );
  const selectedControlCount = context.controlGroups.filter((group) =>
    isCapabilityControlGroupSelected(value, group)
  ).length;

  return (
    <Flex vertical gap={token.paddingSM}>
      <Flex gap={token.paddingSM} align="flex-start" wrap>
        <Flex vertical gap={token.paddingXXS} style={{ flex: '1 1 220px', minWidth: 0 }}>
          <Typography.Text strong>Access level</Typography.Text>
          <Select<CapabilityPolicyPresetId>
            aria-label={`${label} access preset`}
            value={value.preset}
            disabled={disabled}
            style={{ width: '100%' }}
            onChange={(preset) => onChange(applyCapabilityPreset(value, context, preset))}
            options={[
              ...context.presets.map((preset) => ({
                value: preset.id,
                label: preset.label,
                title: preset.summary,
              })),
              ...(value.preset === 'custom'
                ? [{ value: 'custom' as const, label: 'Custom', title: 'Custom capabilities' }]
                : []),
            ]}
          />
          <Typography.Text type="secondary">
            {context.presets.find((preset) => preset.id === value.preset)?.summary ??
              'A custom set of capabilities.'}
          </Typography.Text>
        </Flex>

        {context.supportsFilesystem && (
          <Flex vertical gap={token.paddingXXS} style={{ flex: '1 1 280px', minWidth: 0 }}>
            <Typography.Text strong>File access</Typography.Text>
            <Segmented<CapabilityPolicyFsAccess>
              aria-label={`${label} file access`}
              block
              value={value.fs_access}
              disabled={disabled}
              options={fsOptions}
              onChange={(fsAccess) => onChange(updateFilesystemAccess(value, context, fsAccess))}
            />
            <Typography.Text type="secondary">
              {fsAccessDescription[value.fs_access]}
            </Typography.Text>
          </Flex>
        )}
      </Flex>

      {context.kind === 'branch_access' && isManager && !canPromptOrExecute && (
        <Typography.Text type="secondary">
          <LockOutlined aria-hidden /> Manager can contain and configure, but cannot prompt,
          execute, or open a terminal.
        </Typography.Text>
      )}

      <Collapse
        size="small"
        items={[
          {
            key: 'capabilities',
            label: (
              <Flex align="center" gap={token.paddingXS} wrap>
                <Typography.Text strong>Customize access</Typography.Text>
                <Tag>{selectedControlCount} on</Tag>
              </Flex>
            ),
            children: (
              <CapabilitySelection
                value={value}
                context={context}
                onChange={onChange}
                disabled={disabled}
                label={`${label} custom access`}
              />
            ),
          },
        ]}
      />
    </Flex>
  );
}
