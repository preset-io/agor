import type { AgorClient } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CLILoginPage, parseCliKeyName } from './CLILoginPage';

function renderAt(path: string, create = vi.fn()) {
  const client = { service: vi.fn(() => ({ create })) } as unknown as AgorClient;
  render(
    <App>
      <MemoryRouter initialEntries={[path]}>
        <CLILoginPage client={client} currentUserEmail="alice@acme.example.test" />
      </MemoryRouter>
    </App>
  );
  return { client, create };
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
});
