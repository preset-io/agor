import type { User } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp, Form } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { RbacPermissionFields, type RbacPermissionValue } from './RbacPermissionFields';

const owner = { user_id: 'u1', email: 'ada@example.test', name: 'Ada', role: 'member' } as User;
const value: RbacPermissionValue = {
  visibility: 'shared',
  ownerIds: ['u1'],
  groupGrants: [],
  othersCan: 'session',
  othersFsAccess: 'none',
};

function renderFields(props: Partial<React.ComponentProps<typeof RbacPermissionFields>> = {}) {
  const onChange = vi.fn();
  render(
    <AntApp>
      <Form>
        <RbacPermissionFields
          value={value}
          onChange={onChange}
          allUsers={[owner]}
          allGroups={[]}
          canEdit
          {...props}
        />
      </Form>
    </AntApp>
  );
  return onChange;
}

describe('RbacPermissionFields', () => {
  it('keeps the last owner and says why in the field, not a toast', () => {
    const onChange = renderFields();
    const remove = document.querySelector('.ant-select-selection-item-remove, .ant-tag-close-icon');
    fireEvent.click(remove as HTMLElement);
    expect(screen.getByText('Keep at least one owner.')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalledWith('ownerIds', []);
  });

  it('names a group permissions load failure without guessing a cause', () => {
    renderFields({ groupGrantsUnavailable: true, groupGrantsError: new Error('boom') });
    expect(screen.getByText("Couldn't load group permissions.")).toBeInTheDocument();
    expect(screen.queryByText(/may not be enabled/)).toBeNull();
  });
});
