import type { CapabilityPolicySharingMode } from '@agor/core/types';
import { Flex, Segmented, Typography, theme } from 'antd';

export type PolicyModeSelectorValue = CapabilityPolicySharingMode | 'inherit';

interface PolicyModeSelectorProps {
  /**
   * Direct policies choose only their sharing mode. Inheritable branch
   * policies add Board defaults as the first, package-level choice.
   */
  mode: 'direct' | 'inheritable';
  value: PolicyModeSelectorValue;
  onChange: (value: PolicyModeSelectorValue) => void;
  ariaLabel: string;
  title: string;
  descriptions: Record<CapabilityPolicySharingMode, React.ReactNode> & {
    inherit?: React.ReactNode;
  };
  disabled?: boolean;
}

/** One mode selector shared by board policies, board branch defaults, and branches. */
export const PolicyModeSelector: React.FC<PolicyModeSelectorProps> = ({
  mode,
  value,
  onChange,
  ariaLabel,
  title,
  descriptions,
  disabled,
}) => {
  const { token } = theme.useToken();
  const options = [
    ...(mode === 'inheritable' ? [{ value: 'inherit' as const, label: 'Board defaults' }] : []),
    { value: 'private' as const, label: 'Private' },
    { value: 'shared' as const, label: 'Shared' },
  ];

  return (
    <Flex vertical gap={token.paddingXXS}>
      <Typography.Text strong>{title}</Typography.Text>
      <Segmented<PolicyModeSelectorValue>
        aria-label={ariaLabel}
        block
        value={value}
        disabled={disabled}
        onChange={onChange}
        options={options}
      />
      {descriptions[value] && (
        <Typography.Text type="secondary">{descriptions[value]}</Typography.Text>
      )}
    </Flex>
  );
};
