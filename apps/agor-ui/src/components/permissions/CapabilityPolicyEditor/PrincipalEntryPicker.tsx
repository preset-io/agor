import type { CapabilityPolicyPrincipalDescriptor } from '@agor/core/types';
import { capabilityPolicyPrincipalKey } from '@agor/core/types';
import { PlusOutlined } from '@ant-design/icons';
import { Empty, Select } from 'antd';
import { PrincipalIdentity } from './PrincipalIdentity';

interface PrincipalEntryPickerProps {
  principals: CapabilityPolicyPrincipalDescriptor[];
  onAdd: (principal: CapabilityPolicyPrincipalDescriptor) => void;
  ariaLabel: string;
  placeholder?: string;
  emptyDescription?: string;
}

/**
 * Adds exactly one existing person or group per selection. This deliberately
 * is not a tags/multi-select accumulator: every selected principal becomes an
 * independently editable policy entry.
 */
export const PrincipalEntryPicker: React.FC<PrincipalEntryPickerProps> = ({
  principals,
  onAdd,
  ariaLabel,
  placeholder = 'Add one person or group',
  emptyDescription = 'No active people or groups available',
}) => {
  const descriptorByKey = new Map(
    principals.map((principal) => [capabilityPolicyPrincipalKey(principal.principal), principal])
  );

  return (
    <Select<string>
      showSearch
      aria-label={ariaLabel}
      placeholder={placeholder}
      prefix={<PlusOutlined aria-hidden />}
      value={null}
      onSelect={(key) => {
        const descriptor = descriptorByKey.get(key);
        if (descriptor) onAdd(descriptor);
      }}
      optionFilterProp="searchText"
      style={{ width: '100%', minWidth: 0 }}
      options={principals.map((principal) => ({
        value: capabilityPolicyPrincipalKey(principal.principal),
        label: principal.display_name,
        searchText: `${principal.display_name} ${principal.secondary_label ?? ''} ${principal.principal.principal_type}`,
        descriptor: principal,
      }))}
      optionRender={(option) => <PrincipalIdentity descriptor={option.data.descriptor} compact />}
      notFoundContent={
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyDescription} />
      }
    />
  );
};
