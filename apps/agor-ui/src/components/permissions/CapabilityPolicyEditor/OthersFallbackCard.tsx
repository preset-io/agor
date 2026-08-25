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
        description="Used only when no person or group entry matches. Active workspace members only."
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
