import { type AgorClient, type Branch, serverSearchText } from '@agor-live/client';
import { Select } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { rowsOf } from '@/store/idReads';
import { useDebouncedSearchQuery } from '../GlobalSearch/useGlobalSearch';

/** Options per read; typing narrows them on the server. */
const OPTION_LIMIT = 50;

interface BranchSelectProps {
  client: AgorClient | null;
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
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
}) => {
  const [searchText, setSearchText] = useState('');
  const { debouncedQuery } = useDebouncedSearchQuery(searchText);
  const search = debouncedQuery.trim();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState<Branch | null>(null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setLoading(true);
    client
      .service('branches')
      .find({
        query: {
          archived: false,
          ...(search ? { search: serverSearchText(search) } : {}),
          $limit: OPTION_LIMIT,
          $sort: { name: 1 },
        },
      })
      .then((found) => {
        if (!cancelled) setBranches(rowsOf<Branch>(found));
      })
      .catch((err) => console.warn('[BranchSelect] branch read failed:', err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, search]);

  const listed = !!value && branches.some((b) => b.branch_id === value);
  useEffect(() => {
    if (!client || !value || listed || saved?.branch_id === value) return;
    let cancelled = false;
    client
      .service('branches')
      .get(value)
      .then((branch) => {
        if (!cancelled) setSaved(branch as Branch);
      })
      .catch(() => {
        // A missing or unreadable target keeps its id and reveals nothing.
      });
    return () => {
      cancelled = true;
    };
  }, [client, value, listed, saved?.branch_id]);

  const options = useMemo(() => {
    const rows =
      saved && !branches.some((b) => b.branch_id === saved.branch_id)
        ? [saved, ...branches]
        : branches;
    return rows.map((b) => ({ value: b.branch_id, label: labelOf(b) }));
  }, [branches, saved]);

  return (
    <Select
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled}
      showSearch
      filterOption={false}
      onSearch={setSearchText}
      loading={loading}
      options={options}
    />
  );
};
