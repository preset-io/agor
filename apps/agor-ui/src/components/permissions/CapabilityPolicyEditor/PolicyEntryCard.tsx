import type {
  CapabilityPolicyEntryDraft,
  CapabilityPolicyPrincipalDescriptor,
} from '@agor/core/types';
import { DeleteOutlined, WarningOutlined } from '@ant-design/icons';
import { Alert, Button, Flex, Popconfirm, theme } from 'antd';
import { AccessGrantControls } from './AccessGrantControls';
import { PrincipalIdentity } from './PrincipalIdentity';
import type { CapabilityPolicyEditorContext } from './policyEditorModel';

interface PolicyEntryCardProps {
  value: CapabilityPolicyEntryDraft;
  descriptor?: CapabilityPolicyPrincipalDescriptor;
  context: CapabilityPolicyEditorContext;
  onChange: (value: CapabilityPolicyEntryDraft) => void;
  onRemove: () => void;
  disabled?: boolean;
}

export const PolicyEntryCard: React.FC<PolicyEntryCardProps> = ({
  value,
  descriptor,
  context,
  onChange,
  onRemove,
  disabled,
}) => {
  const { token } = theme.useToken();
  const label = descriptor?.display_name ?? 'Unavailable principal';

  return (
    <Flex vertical gap={token.paddingSM} aria-label={`Access entry for ${label}`}>
      <Flex align="center" justify="space-between" gap={token.paddingSM} wrap>
        <div style={{ minWidth: 0, flex: 1 }}>
          <PrincipalIdentity descriptor={descriptor} />
        </div>
        {!disabled && (
          <Popconfirm
            title={`Remove ${label}?`}
            description="This named entry will no longer contribute access."
            okText="Remove entry"
            okButtonProps={{ danger: true }}
            onConfirm={onRemove}
          >
            <Button
              danger
              type="text"
              icon={<DeleteOutlined />}
              aria-label={`Remove access entry for ${label}`}
            >
              Remove
            </Button>
          </Popconfirm>
        )}
      </Flex>

      {descriptor?.status !== 'active' && (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          title={
            descriptor?.status === 'inactive'
              ? 'Inactive principal receives no effective access'
              : 'Deleted or unavailable principal receives no effective access'
          }
          description="Keep this visible for audit context or remove the stale entry. It never activates the Others fallback for this identity."
        />
      )}

      <AccessGrantControls
        value={value}
        context={context}
        onChange={onChange}
        disabled={disabled}
        label={label}
      />
    </Flex>
  );
};
