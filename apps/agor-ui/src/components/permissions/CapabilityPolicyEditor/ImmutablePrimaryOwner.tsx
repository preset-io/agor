import type { CapabilityPolicyPrincipalDescriptor } from '@agor/core/types';
import { LockOutlined } from '@ant-design/icons';
import { Flex } from 'antd';
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
  return (
    <Flex
      justify="space-between"
      align="center"
      gap="small"
      wrap
      aria-label={`Primary owner for this ${resourceLabel}`}
    >
      <PrincipalIdentity descriptor={owner} compact />
      <Tag icon={<LockOutlined />} color="blue">
        Primary owner · read only
      </Tag>
    </Flex>
  );
};
