import type { CapabilityPolicyPrincipalDescriptor } from '@agor/core/types';
import { Flex } from 'antd';
import { Tag } from '@/components/Tag';
import { PrincipalIdentity } from './PrincipalIdentity';

interface PrimaryOwnerProps {
  action?: React.ReactNode;
  owner?: CapabilityPolicyPrincipalDescriptor;
  resourceLabel: 'board' | 'branch';
}

export const PrimaryOwner: React.FC<PrimaryOwnerProps> = ({ owner, action, resourceLabel }) => {
  return (
    <Flex
      justify="space-between"
      align="center"
      gap="small"
      wrap
      aria-label={`Primary owner for this ${resourceLabel}`}
    >
      <Flex align="center" gap="small" style={{ minWidth: 0, maxWidth: '100%' }}>
        <PrincipalIdentity descriptor={owner} compact />
        {action}
      </Flex>
      <Tag color="blue">Primary owner</Tag>
    </Flex>
  );
};
