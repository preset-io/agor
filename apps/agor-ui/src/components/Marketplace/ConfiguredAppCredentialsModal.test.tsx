import { MCP_HEADER_REDACTED_SENTINEL } from '@agor/core/tools/mcp/http-headers';
import type { AgorClient, MCPServer } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfiguredAppCredentialsModal } from './ConfiguredAppCredentialsModal';

const SERVER = {
  mcp_server_id: 'server-1',
  name: 'hubspot',
  transport: 'http',
  scope: 'session',
  source: 'catalog',
  catalog_entry_name: 'com.hubspot/mcp',
  enabled: true,
  config_version: 4,
  auth: {
    type: 'oauth',
    oauth_mode: 'per_user',
    oauth_dcr_mode: 'disabled',
    oauth_client_id: 'old-client',
    // What every read returns in place of the saved secret.
    oauth_client_secret: MCP_HEADER_REDACTED_SENTINEL,
  },
} as unknown as MCPServer;

function renderModal(secretRequired = true) {
  const patch = vi.fn().mockResolvedValue({});
  const client = { service: () => ({ patch }) } as unknown as AgorClient;
  const onClose = vi.fn();
  render(
    <ConfiguredAppCredentialsModal
      server={SERVER}
      secretRequired={secretRequired}
      client={client}
      onClose={onClose}
    />
  );
  const id = () => screen.getByLabelText('OAuth app Client ID') as HTMLInputElement;
  const secret = () => screen.getByLabelText('OAuth app Client secret') as HTMLInputElement;
  const save = () => screen.getByRole('button', { name: 'Save credentials' });
  return { patch, onClose, id, secret, save };
}

describe('ConfiguredAppCredentialsModal', () => {
  it('shows the saved Client ID, says a secret is saved without echoing it, and warns about reconnecting', () => {
    const { id, secret } = renderModal();
    expect(id().value).toBe('old-client');
    expect(secret().value).toBe('');
    expect(document.body.textContent).not.toContain(MCP_HEADER_REDACTED_SENTINEL);
    expect(screen.getByText(/A secret is saved and never shown/)).toBeTruthy();
    expect(screen.getByText(/Everyone using this installation must reconnect/)).toBeTruthy();
  });

  it('requires a new secret with a new Client ID, then patches both through mcp-servers', async () => {
    const { patch, onClose, id, secret, save } = renderModal();
    fireEvent.change(id(), { target: { value: ' new-client ' } });
    expect(screen.getByText('A new Client ID needs its own Client secret.')).toBeTruthy();
    expect(save()).toHaveProperty('disabled', true);

    fireEvent.change(secret(), { target: { value: 'new-secret' } });
    expect(save()).toHaveProperty('disabled', false);
    fireEvent.click(save());

    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    expect(patch).toHaveBeenCalledWith('server-1', {
      auth: { type: 'oauth', oauth_client_id: 'new-client', oauth_client_secret: 'new-secret' },
      expected_config_version: 4,
    });
  });

  it('replaces only the secret and keeps the Client ID', async () => {
    const { patch, onClose, secret, save } = renderModal();
    expect(save()).toHaveProperty('disabled', true);
    fireEvent.change(secret(), { target: { value: 'rotated-secret' } });
    fireEvent.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    expect(patch).toHaveBeenCalledWith('server-1', {
      auth: { type: 'oauth', oauth_client_id: 'old-client', oauth_client_secret: 'rotated-secret' },
      expected_config_version: 4,
    });
  });

  it('clears the saved secret with a new Client ID when the recipe does not require one', async () => {
    const { patch, id, save } = renderModal(false);
    fireEvent.change(id(), { target: { value: 'public-client' } });
    expect(
      screen.getByText('Changing the Client ID clears the saved secret unless you enter a new one.')
    ).toBeTruthy();
    fireEvent.click(save());
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('server-1', {
        auth: { type: 'oauth', oauth_client_id: 'public-client', oauth_client_secret: null },
        expected_config_version: 4,
      })
    );
  });

  it('sends the new secret with a new Client ID when one is entered for an optional-secret recipe', async () => {
    const { patch, id, secret, save } = renderModal(false);
    fireEvent.change(id(), { target: { value: 'public-client' } });
    fireEvent.change(secret(), { target: { value: 'optional-secret' } });
    fireEvent.click(save());
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('server-1', {
        auth: {
          type: 'oauth',
          oauth_client_id: 'public-client',
          oauth_client_secret: 'optional-secret',
        },
        expected_config_version: 4,
      })
    );
  });
});
