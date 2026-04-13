import type { Worktree } from '@agor-live/client';
import { Select } from 'antd';
import { useMemo } from 'react';

interface WorktreeSelectProps {
  worktreeById: Map<string, Worktree>;
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  includeArchivedLabel?: boolean;
}

export const WorktreeSelect: React.FC<WorktreeSelectProps> = ({
  worktreeById,
  value,
  onChange,
  placeholder = 'Select a worktree',
  disabled = false,
  includeArchivedLabel = true,
}) => {
  const options = useMemo(
    () =>
      Array.from(worktreeById.values())
        .sort((a, b) =>
          (a.name || a.ref || a.worktree_id).localeCompare(b.name || b.ref || b.worktree_id)
        )
        .map((wt) => ({
          value: wt.worktree_id,
          label: `${wt.name || wt.ref || wt.worktree_id}${includeArchivedLabel && wt.archived ? ' (archived)' : ''}`,
        })),
    [includeArchivedLabel, worktreeById]
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
