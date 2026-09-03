import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { DeleteZoneModal } from './DeleteZoneModal';

vi.mock('../../../contexts/ConnectionContext', () => ({
  useMutationGate: () => ({ canMutate: true }),
}));

describe('DeleteZoneModal', () => {
  it('makes the non-destructive orphaning behavior explicit', () => {
    const onConfirm = vi.fn();
    render(
      <AntdApp>
        <DeleteZoneModal
          open
          onCancel={vi.fn()}
          onConfirm={onConfirm}
          zoneName="Review"
          pinnedItemCount={2}
        />
      </AntdApp>
    );

    expect(screen.getByText(/This removes only the zone/)).toBeInTheDocument();
    expect(
      screen.getByText(/Branches, cards, comments, notes, and sessions are kept/)
    ).toBeInTheDocument();
    expect(screen.getByText('2 pinned items will be unpinned')).toBeInTheDocument();
    expect(screen.queryByText(/Delete pinned items too/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete zone' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
