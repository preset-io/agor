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
