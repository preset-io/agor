import { type AgorClient, type Branch, isTeammate, serverSearchText } from '@agor-live/client';
import { Select, type SelectProps } from 'antd';
import { useMemo, useState } from 'react';
import { useServerRead } from '@/hooks/useServerRead';
import { rowsOf } from '@/store/idReads';
import { teammateLabel } from '@/utils/teammateLabels';
import { useDebouncedSearchQuery } from '../GlobalSearch/useGlobalSearch';

/** Options per read; typing narrows them on the server. */
const OPTION_LIMIT = 50;
const NO_BRANCHES: Branch[] = [];

interface BranchSelectProps
  extends Pick<
    SelectProps,
    'id' | 'aria-label' | 'aria-describedby' | 'aria-invalid' | 'aria-required'
  > {
  client: AgorClient | null;
  value?: string;
  onChange?: (value: string, branch?: Branch) => void;
  placeholder?: string;
  disabled?: boolean;
  teammatesOnly?: boolean;
  /** Optional empty-state guidance supplied by the selector's caller. */
  emptyText?: string;
}

const labelOf = (branch: Branch) =>
  `${branch.name || branch.ref || branch.branch_id}${branch.archived ? ' (archived)' : ''}`;

/**
 * A branch picker that reads its options from the daemon — the active
 * branches matching the typed text (`search`), debounced — instead of the
 * store, which holds only the loaded scopes. A saved value outside the
 * options is labelled by one `get`; one the caller can't read keeps its id.
 * The rows are local display state and never enter the store.
 */
export const BranchSelect: React.FC<BranchSelectProps> = ({
  client,
  value,
  onChange,
  placeholder = 'Select a branch',
  disabled = false,
  teammatesOnly = false,
  emptyText,
  ...accessibilityProps
}) => {
  const [searchText, setSearchText] = useState('');
  const { debouncedQuery } = useDebouncedSearchQuery(searchText);
  const search = debouncedQuery.trim();
  const { data, loading } = useServerRead(
    client,
    `branch-select\u0000${teammatesOnly}\u0000${search}`,
    async (reader) =>
      rowsOf<Branch>(
        await reader.service('branches').find({
          query: {
            archived: false,
            ...(teammatesOnly ? { teammate: true } : {}),
            ...(search ? { search: serverSearchText(search) } : {}),
            $limit: OPTION_LIMIT,
            $sort: { name: 1 },
          },
        })
      ),
    { keepPrevious: true }
  );
  const branches = data ?? NO_BRANCHES;
  const listed = !!value && branches.some((b) => b.branch_id === value);
  // A missing or unreadable target keeps its id and reveals nothing.
  const { data: saved } = useServerRead(
    client,
    value && !listed ? `branch\u0000${value}` : null,
    (reader) =>
      (reader.service('branches').get(value as string) as Promise<Branch>).catch(() => undefined)
  );

  const options = useMemo(() => {
    const rows =
      saved && !branches.some((b) => b.branch_id === saved.branch_id)
        ? [saved, ...branches]
        : branches;
    return rows
      .filter((b) => !teammatesOnly || (isTeammate(b) && !b.archived))
      .map((b) => ({
        value: b.branch_id,
        branch: b,
        // Keep branch context in the text label, including the selected value
        // and accessible option name, not just in the open dropdown.
        label: teammatesOnly ? `${teammateLabel(b)} (${labelOf(b)})` : labelOf(b),
      }));
  }, [branches, saved, teammatesOnly]);

  return (
    <Select
      {...accessibilityProps}
      value={value}
      onChange={(id, option) => onChange?.(id, Array.isArray(option) ? undefined : option?.branch)}
      placeholder={placeholder}
      disabled={disabled}
      showSearch
      filterOption={false}
      onSearch={setSearchText}
      loading={loading}
      options={options}
      notFoundContent={
        teammatesOnly
          ? loading
            ? 'Loading AI Teammates…'
            : data === undefined
              ? 'Unable to load AI Teammates. Check your connection and try again.'
              : search
                ? 'No matching AI Teammates.'
                : (emptyText ?? 'No AI Teammates available.')
          : emptyText
      }
    />
  );
};
