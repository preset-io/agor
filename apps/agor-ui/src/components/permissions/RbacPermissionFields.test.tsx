/**
 * RbacPermissionFields — private-board multi-owner behavior.
 *
 * The backend already supports a private board (or branch) with several named
 * owners; these tests pin the UI so private no longer collapses to one owner
 * and the Owners picker stays reachable in both visibility modes.
 */

import type { User } from '@agor-live/client';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { RbacPermissionFields, type RbacPermissionValue } from './RbacPermissionFields';

const makeUser = (overrides: Partial<User> = {}): User =>
  ({
    user_id: 'user-1',
    email: 'alice@example.com',
    name: 'Alice',
    role: 'member',
    ...overrides,
  }) as User;

const alice = makeUser();
const bob = makeUser({ user_id: 'user-2', email: 'bob@example.com', name: 'Bob' });

const baseValue = (overrides: Partial<RbacPermissionValue> = {}): RbacPermissionValue => ({
  visibility: 'shared',
  ownerIds: ['user-1'],
  groupGrants: [],
  othersCan: 'session',
  othersFsAccess: 'read',
  allowSessionSharing: false,
  ...overrides,
});

/** Controlled harness so the rendered value reflects onChange updates. */
function Harness({
  initial,
  onChangeSpy,
}: {
  initial: RbacPermissionValue;
  onChangeSpy?: (key: keyof RbacPermissionValue, value: unknown) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <AntApp>
      <RbacPermissionFields
        value={value}
        onChange={(key, next) => {
          onChangeSpy?.(key, next);
          setValue((prev) => ({ ...prev, [key]: next }));
        }}
        allUsers={[alice, bob]}
        allGroups={[]}
        currentUser={alice}
        canEdit
      />
    </AntApp>
  );
}

describe('RbacPermissionFields — private multi-owner', () => {
  it('renders the Owners picker when visibility is private', () => {
    render(<Harness initial={baseValue({ visibility: 'private', othersCan: 'none' })} />);
    expect(screen.getByText('Owners')).toBeInTheDocument();
  });

  it('preserves all owners when switching a board to private', () => {
    const onChangeSpy = vi.fn();
    render(
      <Harness initial={baseValue({ ownerIds: ['user-1', 'user-2'] })} onChangeSpy={onChangeSpy} />
    );

    fireEvent.click(screen.getByRole('radio', { name: /Private/ }));

    const ownerIdCalls = onChangeSpy.mock.calls.filter(([key]) => key === 'ownerIds');
    expect(ownerIdCalls).toHaveLength(0);
    expect(screen.getByText(/Alice.*\(You\)/)).toBeInTheDocument();
    expect(screen.getByText(/Bob/)).toBeInTheDocument();
  });

  it('adds a second owner to an already-private board', () => {
    const onChangeSpy = vi.fn();
    render(
      <Harness
        initial={baseValue({ visibility: 'private', othersCan: 'none' })}
        onChangeSpy={onChangeSpy}
      />
    );

    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(screen.getByText('Bob (bob@example.com)'));

    expect(onChangeSpy).toHaveBeenCalledWith('ownerIds', ['user-1', 'user-2']);
  });

  it('enforces the at-least-one-owner floor on a private board', async () => {
    const onChangeSpy = vi.fn();
    render(
      <Harness
        initial={baseValue({ visibility: 'private', othersCan: 'none' })}
        onChangeSpy={onChangeSpy}
      />
    );

    const ownerItem = screen.getByText('Owners').closest('.ant-form-item') as HTMLElement;
    fireEvent.click(within(ownerItem).getByLabelText('Close'));

    expect(onChangeSpy).not.toHaveBeenCalledWith('ownerIds', []);
    expect(await screen.findByText('At least one owner is required')).toBeInTheDocument();
  });
});
