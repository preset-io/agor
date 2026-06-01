import type { Branch } from '@agor-live/client';
import { Select } from 'antd';
import { useMemo } from 'react';

interface BranchSelectProps {
  branchById: Map<string, Branch>;
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  includeArchivedLabel?: boolean;
}

export const BranchSelect: React.FC<BranchSelectProps> = ({
  branchById,
  value,
  onChange,
  placeholder = 'Select a branch',
  disabled = false,
  includeArchivedLabel = true,
}) => {
  const options = useMemo(
    () =>
      Array.from(branchById.values())
        .sort((a, b) =>
          (a.name || a.ref || a.branch_id).localeCompare(b.name || b.ref || b.branch_id)
        )
        .map((wt) => ({
          value: wt.branch_id,
          label: `${wt.name || wt.ref || wt.branch_id}${includeArchivedLabel && wt.archived ? ' (archived)' : ''}`,
        })),
    [includeArchivedLabel, branchById]
  );

  return (
    <Select
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled}
      showSearch
      optionFilterProp="label"
      options={options}
    />
  );
};
