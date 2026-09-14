import type {
  CapabilityPolicyEntryDraft,
  CapabilityPolicyFsAccess,
  CapabilityPolicyOthersDraft,
  CapabilityPolicyPresetId,
} from '@agor/core/types';
import { InfoCircleOutlined } from '@ant-design/icons';
import { Button, Flex, Select, Tooltip, Typography, theme } from 'antd';
import type { CapabilityPolicyEditorContext } from './policyEditorModel';
import {
  applyCapabilityPreset,
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
  compact?: boolean;
  field?: 'all' | 'role' | 'filesystem';
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
  compact,
  field = 'all',
}: AccessGrantControlsProps<T>) {
  const { token } = theme.useToken();
  const role = getCapabilityPreset(context, value.preset);
  const showLabels = !compact;
  const showRole = field === 'all' || field === 'role';
  const showFilesystem = context.supportsFilesystem && (field === 'all' || field === 'filesystem');

  return (
    <Flex vertical gap={token.paddingXS} style={{ flex: 1, minWidth: 0 }}>
      <Flex gap={token.paddingSM} align={compact ? 'center' : 'flex-start'} wrap={!compact}>
        {showRole && (
          <Flex
            vertical
            gap={token.paddingXXS}
            style={{
              flex: showFilesystem ? '1 1 180px' : '1 1 240px',
              minWidth: 0,
            }}
          >
            {showLabels && <Typography.Text strong>Role</Typography.Text>}
            <Flex align="center" gap={token.paddingXXS}>
              <Select<CapabilityPolicyPresetId>
                aria-label={`${label} role`}
                value={value.preset}
                disabled={disabled}
                style={{ flex: 1, minWidth: 0 }}
                onChange={(preset) => onChange(applyCapabilityPreset(value, context, preset))}
                options={context.presets.map((preset) => ({
                  value: preset.id,
                  label: preset.label,
                  title: preset.summary,
                  summary: preset.summary,
                }))}
                optionRender={(option) => (
                  <Flex vertical gap={2} style={{ paddingBlock: token.paddingXXS }}>
                    <Typography.Text strong>{option.label}</Typography.Text>
                    <Typography.Text type="secondary" style={{ whiteSpace: 'normal' }}>
                      {option.data.summary}
                    </Typography.Text>
                  </Flex>
                )}
              />
              <Tooltip title={role?.summary ?? 'Choose a supported role.'}>
                <Button
                  type="text"
                  size="small"
                  icon={<InfoCircleOutlined />}
                  aria-label={`${label} role details`}
                />
              </Tooltip>
            </Flex>
          </Flex>
        )}

        {showFilesystem && (
          <Flex vertical gap={token.paddingXXS} style={{ flex: '1 1 240px', minWidth: 0 }}>
            {showLabels && (
              <Flex align="center" gap={token.paddingXXS}>
                <Typography.Text strong>File access</Typography.Text>
                <Tooltip title="Controls branch file mounts.">
                  <InfoCircleOutlined aria-label="File access details" />
                </Tooltip>
              </Flex>
            )}
            <Select<CapabilityPolicyFsAccess>
              aria-label={`${label} file access`}
              value={value.fs_access}
              disabled={disabled || value.preset === 'none'}
              options={fsOptions}
              style={{ width: '100%' }}
              onChange={(fsAccess) => onChange(updateFilesystemAccess(value, context, fsAccess))}
            />
          </Flex>
        )}
      </Flex>
    </Flex>
  );
}
