import type { AgorClient, Branch } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '@/contexts/ConnectionContext';
import { TeammateTab } from './TeammateTab';

const branch = {
  branch_id: 'branch-1',
  archived: false,
  custom_context: { teammate: { kind: 'teammate', displayName: 'Ada' } },
} as unknown as Branch;

function renderTab(errors: Error[]) {
  const create = vi.fn(async () => {
    const next = errors.shift();
    if (next) throw next;
    return {};
  });
  const client = { service: () => ({ create }) } as unknown as AgorClient;
  const onRetired = vi.fn();
  render(
    <AntApp>
      <ConnectionProvider
        value={{
          connected: true,
          connecting: false,
          authGeneration: 1,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <TeammateTab
          branch={branch}
          client={client}
          onRetired={onRetired}
          canEdit
          state={{ displayName: 'Ada', emoji: '', description: '' }}
          setField={vi.fn()}
        />
      </ConnectionProvider>
    </AntApp>
  );
  return { create, onRetired };
}

async function retire() {
  fireEvent.click(screen.getByRole('button', { name: 'Retire teammate' }));
  fireEvent.click(await screen.findByRole('button', { name: 'OK' }));
}

describe('TeammateTab retire', () => {
  it('treats a retry after its own lost reply as retired', async () => {
    const { create, onRetired } = renderTab([
      new Error('socket has been disconnected'),
      new Error('Retirement requires an active teammate'),
    ]);
    await retire();
    expect(
      await screen.findByText(
        "The connection to Agor dropped before this was confirmed. If it didn't go through, try to retire the teammate again once the connection is back. (socket has been disconnected)"
      )
    ).toBeTruthy();
    await retire();
    await waitFor(() => expect(onRetired).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Teammate retired; files preserved')).toBeTruthy();
  });

  it('reports the refusal when there was no lost reply', async () => {
    const { onRetired } = renderTab([new Error('Retirement requires an active teammate')]);
    await retire();
    expect(
      await screen.findByText(
        "Couldn't retire the teammate. (Retirement requires an active teammate)"
      )
    ).toBeTruthy();
    expect(onRetired).not.toHaveBeenCalled();
  });
});
