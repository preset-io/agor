import type { CapabilityPolicyOthersDraft } from '@agor/core/types';
import { GlobalOutlined } from '@ant-design/icons';
import { Alert, Flex, Typography, theme } from 'antd';
import { Tag } from '@/components/Tag';
import { AccessGrantControls } from './AccessGrantControls';
import type { CapabilityPolicyEditorContext } from './policyEditorModel';

interface OthersFallbackCardProps {
  value: CapabilityPolicyOthersDraft;
  context: CapabilityPolicyEditorContext;
  onChange: (value: CapabilityPolicyOthersDraft) => void;
  disabled?: boolean;
}

export const OthersFallbackCard: React.FC<OthersFallbackCardProps> = ({
  value,
  context,
  onChange,
  disabled,
}) => {
  const { token } = theme.useToken();

  return (
    <Flex vertical gap={token.paddingSM}>
      <Flex align="center" gap={token.paddingXS} wrap>
        <GlobalOutlined aria-hidden />
        <Typography.Text strong>Others — unmatched active workspace members</Typography.Text>
        <Tag color="gold">Fallback</Tag>
      </Flex>
      <Alert
        type="info"
        showIcon
        title="Fallback, not an additional grant"
        description="Applies only when an active same-workspace member has no active person or group match. Never anonymous, inactive, deleted, or cross-tenant."
      />
      <AccessGrantControls
        value={value}
        context={context}
        onChange={onChange}
        disabled={disabled}
        label="Others fallback"
      />
    </Flex>
  );
};
