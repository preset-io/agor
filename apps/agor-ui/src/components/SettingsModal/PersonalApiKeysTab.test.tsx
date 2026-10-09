import type { AgorClient } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { PersonalApiKeysTab } from './PersonalApiKeysTab';

describe('PersonalApiKeysTab authority fencing', () => {
  it('does not reveal an old-generation create result and preserves the name draft', async () => {
    let resolve!: (value: unknown) => void;
    const pendingCreate = new Promise<unknown>((done) => {
      resolve = done;
    });
    const findAll = vi.fn().mockResolvedValue([]);
    const create = vi.fn(() => pendingCreate);
    const client = {
      service: (path: string) => {
        if (path !== 'api/v1/user/api-keys') throw new Error(path);
        return { findAll, create, remove: vi.fn() };
      },
    } as unknown as AgorClient;
    const view = (generation: number) => (
      <AntApp>
        <PersonalApiKeysTab
          client={client}
          identityKey="member-a:member"
          operationScope={['member-a:member', generation]}
        />
      </AntApp>
    );
    const rendered = render(view(1));
    await waitFor(() => expect(findAll).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /create new key/i }));
    fireEvent.change(screen.getByPlaceholderText(/CI Pipeline/), {
      target: { value: 'same-user draft key' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    expect(create).toHaveBeenCalledWith({ name: 'same-user draft key' });

    rendered.rerender(view(2));
    await act(async () => {
      resolve({
        rawKey: 'agor_old_generation_private_key',
        key: { id: 'old', name: 'old', prefix: 'agor_old', created_at: new Date().toISOString() },
      });
      await pendingCreate;
    });

    expect(screen.queryByDisplayValue('agor_old_generation_private_key')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/CI Pipeline/)).toHaveValue('same-user draft key');
  });
});

describe('PersonalApiKeysTab failures', () => {
  function renderTab(service: Record<string, unknown>) {
    const client = { service: () => service } as unknown as AgorClient;
    return render(
      <AntApp>
        <PersonalApiKeysTab
          client={client}
          identityKey="member-a:member"
          operationScope={['member-a:member', 1]}
        />
      </AntApp>
    );
  }

  it('shows a list failure instead of an empty list and retries on Try again', async () => {
    const findAll = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([
        { id: 'k1', name: 'CI', prefix: 'agor_ab', created_at: '2026-01-01T00:00:00Z' },
      ]);
    renderTab({ findAll, create: vi.fn(), remove: vi.fn() });
    expect(await screen.findByText("Couldn't load your API keys.")).toBeInTheDocument();
    expect(screen.queryByText('No API keys yet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('CI')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load your API keys.")).toBeNull();
  });

  it('keeps the create form open with the name and the error', async () => {
    const create = vi.fn().mockRejectedValue(new Error('boom'));
    renderTab({ findAll: vi.fn().mockResolvedValue([]), create, remove: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: /create new key/i }));
    fireEvent.change(screen.getByPlaceholderText(/CI Pipeline/), { target: { value: 'Laptop' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    expect(await screen.findByText("Couldn't create the API key.")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/CI Pipeline/)).toHaveValue('Laptop');
  });
});
