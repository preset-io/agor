import type { CapabilityPolicyPrincipalDescriptor } from '@agor/core/types';
import { LockOutlined } from '@ant-design/icons';
import { Alert, Card, Flex, Typography, theme } from 'antd';
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
    <Card
      size="small"
      aria-label={`Immutable primary owner for this ${resourceLabel}`}
      styles={{ body: { padding: token.paddingSM } }}
    >
      <Flex vertical gap={10}>
        <Flex justify="space-between" align="center" gap={12} wrap>
          <PrincipalIdentity descriptor={owner} />
          <Tag icon={<LockOutlined />} color="blue">
            Primary owner
          </Tag>
        </Flex>
        <Alert
          type="info"
          showIcon
          title="Ownership is fixed"
          description={
            <Typography.Text>
              The primary owner cannot be changed in this version. Managers can edit shared access,
              but they never become owners or inherit conversation credentials.
            </Typography.Text>
          }
        />
      </Flex>
    </Card>
  );
};
