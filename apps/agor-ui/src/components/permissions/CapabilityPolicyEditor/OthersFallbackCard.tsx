import type { CapabilityPolicyOthersDraft } from '@agor/core/types';
import { GlobalOutlined } from '@ant-design/icons';
import { Alert, Card, Flex, Typography, theme } from 'antd';
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
    <Card size="small" styles={{ body: { padding: token.paddingSM } }}>
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
          description="Applies only to an active member of this workspace when no active direct-person or group entry matches them. It never means anonymous users, inactive users, deleted users, or members of another tenant."
        />
        <AccessGrantControls
          value={value}
          context={context}
          onChange={onChange}
          disabled={disabled}
          label="Others fallback"
        />
      </Flex>
    </Card>
  );
};
