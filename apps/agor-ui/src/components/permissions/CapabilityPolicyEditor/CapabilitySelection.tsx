import type { CapabilityPolicyEntryDraft, CapabilityPolicyOthersDraft } from '@agor/core/types';
import { Checkbox, Flex, Typography, theme } from 'antd';
import { useId } from 'react';
import type { CapabilityPolicyEditorContext } from './policyEditorModel';
import {
  isCapabilityControlGroupSelected,
  toggleCapabilityControlGroup,
} from './policyEditorModel';

interface CapabilitySelectionProps<
  T extends CapabilityPolicyEntryDraft | CapabilityPolicyOthersDraft,
> {
  value: T;
  context: CapabilityPolicyEditorContext;
  onChange: (value: T) => void;
  disabled?: boolean;
  label: string;
}

export function CapabilitySelection<
  T extends CapabilityPolicyEntryDraft | CapabilityPolicyOthersDraft,
>({ value, context, onChange, disabled, label }: CapabilitySelectionProps<T>) {
  const { token } = theme.useToken();
  const descriptionPrefix = useId();

  return (
    <fieldset
      aria-label={label}
      disabled={disabled}
      style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
    >
      <Flex vertical gap={token.paddingXS}>
        <Typography.Text type="secondary">
          These simple controls map to the exact checks the authorization layer will enforce.
        </Typography.Text>
        {context.controlGroups.map((group) => (
          <Flex
            key={group.id}
            align="flex-start"
            gap={token.paddingXS}
            style={{ paddingBlock: token.paddingXXS }}
          >
            <Checkbox
              checked={isCapabilityControlGroupSelected(value, group)}
              onChange={(event) =>
                onChange(toggleCapabilityControlGroup(value, context, group, event.target.checked))
              }
              aria-describedby={`${descriptionPrefix}-${group.id}-description`}
            >
              <Typography.Text strong>{group.label}</Typography.Text>
            </Checkbox>
            <Typography.Text
              id={`${descriptionPrefix}-${group.id}-description`}
              type="secondary"
              style={{ minWidth: 0, flex: 1, fontSize: token.fontSizeSM }}
            >
              {group.summary}
            </Typography.Text>
          </Flex>
        ))}

        {context.kind === 'branch_access' && (
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            Terminal is available automatically only when <strong>Work in own sessions</strong> is
            enabled and file access is Read or Write. File access alone never grants execution.
          </Typography.Text>
        )}
      </Flex>
    </fieldset>
  );
}
