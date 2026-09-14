import type { CapabilityPolicyPrincipalDescriptor } from '@agor/core/types';
import { TeamOutlined, UserOutlined, WarningOutlined } from '@ant-design/icons';
import { Avatar, Flex, Typography, theme } from 'antd';
import { Tag } from '@/components/Tag';

interface PrincipalIdentityProps {
  descriptor?: CapabilityPolicyPrincipalDescriptor;
  compact?: boolean;
}

const statusLabel: Readonly<
  Record<CapabilityPolicyPrincipalDescriptor['status'], string | undefined>
> = {
  active: undefined,
  inactive: 'Inactive',
  deleted: 'Deleted',
};

export const PrincipalIdentity: React.FC<PrincipalIdentityProps> = ({ descriptor, compact }) => {
  const { token } = theme.useToken();
  const isGroup = descriptor?.principal.principal_type === 'group';
  const label = descriptor?.display_name ?? 'Unavailable principal';
  const status = descriptor?.status ?? 'deleted';
  const secondaryLabel = descriptor?.secondary_label
    ? isGroup
      ? `Group · ${descriptor.secondary_label}`
      : descriptor.secondary_label
    : isGroup
      ? 'Workspace group'
      : undefined;

  return (
    <Flex align="center" gap={compact ? 8 : 12} style={{ minWidth: 0 }}>
      <Avatar
        size={compact ? 28 : 36}
        icon={isGroup ? <TeamOutlined /> : <UserOutlined />}
        style={{
          flex: '0 0 auto',
          background: isGroup ? token.colorPrimaryBg : token.colorFillSecondary,
          color: isGroup ? token.colorPrimary : token.colorTextSecondary,
        }}
      />
      <Flex vertical style={{ minWidth: 0, flex: 1 }}>
        <Flex align="center" gap={6} wrap>
          <Typography.Text strong ellipsis={{ tooltip: label }} style={{ minWidth: 0 }}>
            {label}
          </Typography.Text>
          {statusLabel[status] && (
            <Tag
              icon={<WarningOutlined />}
              color={status === 'deleted' ? 'error' : 'warning'}
              aria-label={`Principal status: ${statusLabel[status]}`}
            >
              {statusLabel[status]}
            </Tag>
          )}
        </Flex>
        {secondaryLabel && (
          <Typography.Text type="secondary" ellipsis={{ tooltip: secondaryLabel }}>
            {secondaryLabel}
          </Typography.Text>
        )}
      </Flex>
    </Flex>
  );
};
