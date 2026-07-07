import type { User } from '@agor-live/client';
import { Select, type SelectProps } from 'antd';

/** Searchable Agor-user picker used by the gateway channel forms. */
export const UserSelect: React.FC<SelectProps<string> & { userById: Map<string, User> }> = ({
  userById,
  placeholder = 'Select a user',
  ...selectProps
}) => (
  <Select {...selectProps} placeholder={placeholder} showSearch optionFilterProp="children">
    {Array.from(userById.values())
      .sort((a, b) =>
        (a.name || a.email || a.user_id).localeCompare(b.name || b.email || b.user_id)
      )
      .map((u) => (
        <Select.Option key={u.user_id} value={u.user_id}>
          {u.name || u.email || u.user_id}
        </Select.Option>
      ))}
  </Select>
);
