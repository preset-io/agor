import type { CapabilityPolicyPrincipalDescriptor } from '@agor/core/types';
import { LockOutlined } from '@ant-design/icons';
import { Flex, Typography, theme } from 'antd';
import { Tag } from '@/components/Tag';
import { PrincipalIdentity } from './PrincipalIdentity';

interface ImmutablePrimaryOwnerProps {
  owner?: CapabilityPolicyPrincipalDescriptor;
  resourceLabel: 'board' | 'branch';
}

export const ImmutablePrimaryOwner: React.FC<ImmutablePrimaryOwnerProps> = ({
  owner,
  resourceLabel,
}) => {
  const { token } = theme.useToken();

  return (
    <Flex
      vertical
      gap={token.paddingXS}
      aria-label={`Immutable primary owner for this ${resourceLabel}`}
    >
      <Flex justify="space-between" align="center" gap={token.paddingSM} wrap>
        <PrincipalIdentity descriptor={owner} compact />
        <Tag icon={<LockOutlined />} color="blue">
          Primary owner · read only
        </Tag>
      </Flex>
      <Typography.Text type="secondary">
        <strong>Ownership is fixed.</strong> Managers never become owners or inherit conversation
        credentials.
      </Typography.Text>
    </Flex>
  );
};
