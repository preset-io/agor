import type {
  CapabilityPolicyCapability,
  CapabilityPolicyEntryDraft,
  CapabilityPolicyOthersDraft,
} from '@agor/core/types';
import { Checkbox, Flex, Typography, theme } from 'antd';
import { useId } from 'react';
import { Tag } from '@/components/Tag';
import type { CapabilityPolicyEditorContext } from './policyEditorModel';
import { toggleCapability } from './policyEditorModel';

interface CapabilitySelectionProps<
  T extends CapabilityPolicyEntryDraft | CapabilityPolicyOthersDraft,
> {
  value: T;
  context: CapabilityPolicyEditorContext;
  onChange: (value: T) => void;
  disabled?: boolean;
  label: string;
}

const familyColor = {
  View: 'default',
  'Prompt / execute': 'purple',
  Manage: 'blue',
} as const;

export function CapabilitySelection<
  T extends CapabilityPolicyEntryDraft | CapabilityPolicyOthersDraft,
>({ value, context, onChange, disabled, label }: CapabilitySelectionProps<T>) {
  const { token } = theme.useToken();
  const descriptionPrefix = useId();

  const handleToggle = (capability: CapabilityPolicyCapability, checked: boolean) => {
    onChange(toggleCapability(value, context, capability, checked));
  };

  return (
    <fieldset
      aria-label={label}
      disabled={disabled}
      style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
    >
      <Flex vertical gap={token.paddingXS}>
        <Typography.Text type="secondary">
          Required capabilities turn on automatically. Removing a prerequisite also removes its
          dependents.
        </Typography.Text>
        {context.capabilities.map((capability) => (
          <Flex
            key={capability.value}
            align="flex-start"
            gap={token.paddingXS}
            style={{ paddingBlock: token.paddingXXS }}
          >
            <Checkbox
              checked={value.capabilities.includes(capability.value)}
              onChange={(event) => handleToggle(capability.value, event.target.checked)}
              aria-describedby={`${descriptionPrefix}-${capability.value}-description`}
            >
              <Typography.Text strong>{capability.label}</Typography.Text>
            </Checkbox>
            <Flex vertical gap={2} style={{ minWidth: 0, flex: 1 }}>
              <Tag color={familyColor[capability.family]} style={{ alignSelf: 'flex-start' }}>
                {capability.family}
              </Tag>
              <Typography.Text
                id={`${descriptionPrefix}-${capability.value}-description`}
                type="secondary"
                style={{ fontSize: token.fontSizeSM }}
              >
                {capability.summary}
              </Typography.Text>
            </Flex>
          </Flex>
        ))}
      </Flex>
    </fieldset>
  );
}
