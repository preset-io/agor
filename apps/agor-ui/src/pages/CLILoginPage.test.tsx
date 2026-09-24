import type { AgorClient } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CLILoginPage, parseCliKeyName } from './CLILoginPage';

function renderAt(path: string, create = vi.fn()) {
  const client = { service: vi.fn(() => ({ create })) } as unknown as AgorClient;
  const page = (userId: string, email: string) => (
    <App>
      <MemoryRouter initialEntries={[path]}>
        <CLILoginPage client={client} currentUserId={userId} currentUserEmail={email} />
      </MemoryRouter>
    </App>
  );
  const view = render(page('user-alice', 'alice@acme.example.test'));
  const switchUser = () => view.rerender(page('user-bob', 'bob@acme.example.test'));
  return { client, create, switchUser };
}

describe('CLI login page', () => {
  it('accepts only CLI-generated machine names', () => {
    expect(parseCliKeyName('agor-cli-maxs-mbp-3f9a')).toBe('agor-cli-maxs-mbp-3f9a');
    for (const value of [null, '', 'CI pipeline', 'agor-cli-', 'agor-cli-UPPER', 'x-agor-cli-a']) {
      expect(parseCliKeyName(value)).toBeNull();
    }
  });

  it('never creates a key on load', () => {
    const { create } = renderAt('/cli-login?name=agor-cli-laptop-1a2b');
    expect(screen.getByText('Signed in as alice@acme.example.test')).toBeTruthy();
    expect(screen.getByText('agor-cli-laptop-1a2b')).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a link without a valid machine name', () => {
    renderAt('/cli-login?name=Production%20deploy');
    expect(screen.getByText('This link is incomplete')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create CLI key' })).toBeNull();
  });

  it('creates a replacing cli_login key on click and shows it once', async () => {
    const create = vi.fn(async () => ({ rawKey: 'agor_sk_created', replaced: 1 }));
    const { client } = renderAt('/cli-login?name=agor-cli-laptop-1a2b', create);

    fireEvent.click(screen.getByRole('button', { name: 'Create CLI key' }));

    await waitFor(() =>
      expect((screen.getByRole('textbox', { name: 'CLI key' }) as HTMLTextAreaElement).value).toBe(
        'agor_sk_created'
      )
    );
    expect(client.service).toHaveBeenCalledWith('api/v1/user/api-keys');
    expect(create).toHaveBeenCalledWith({
      name: 'agor-cli-laptop-1a2b',
      source: 'cli_login',
      replace_previous: true,
    });
    expect(screen.getByText(/replaces this machine's previous CLI key/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Copy key/ })).toBeTruthy();
  });

  it('shows the server error and allows retrying', async () => {
    const create = vi.fn(async () => {
      throw new Error('Maximum of 25 API keys per user');
    });
    renderAt('/cli-login?name=agor-cli-laptop-1a2b', create);

    fireEvent.click(screen.getByRole('button', { name: 'Create CLI key' }));

    await waitFor(() => expect(screen.getByText('Maximum of 25 API keys per user')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Create CLI key' })).toBeTruthy();
  });

  it('erases a displayed key when the signed-in user changes', async () => {
    const create = vi.fn(async () => ({ rawKey: 'agor_sk_alice', replaced: 0 }));
    const { switchUser } = renderAt('/cli-login?name=agor-cli-laptop-1a2b', create);

    fireEvent.click(screen.getByRole('button', { name: 'Create CLI key' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'CLI key' })).toBeTruthy());

    switchUser();

    expect(screen.queryByRole('textbox', { name: 'CLI key' })).toBeNull();
    expect(screen.getByText('Signed in as bob@acme.example.test')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create CLI key' })).toBeTruthy();
  });

  it('discards a key that arrives after the signed-in user changed', async () => {
    let resolveCreate: (value: { rawKey: string }) => void = () => {};
    const create = vi.fn(
      () => new Promise<{ rawKey: string }>((resolve) => (resolveCreate = resolve))
    );
    const { switchUser } = renderAt('/cli-login?name=agor-cli-laptop-1a2b', create);

    fireEvent.click(screen.getByRole('button', { name: 'Create CLI key' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    switchUser();
    resolveCreate({ rawKey: 'agor_sk_late' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByRole('textbox', { name: 'CLI key' })).toBeNull();
    expect(screen.queryByDisplayValue('agor_sk_late')).toBeNull();
  });
});
