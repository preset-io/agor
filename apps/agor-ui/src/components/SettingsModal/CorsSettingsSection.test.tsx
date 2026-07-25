import type { AgorClient, TenantCorsSettings } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { CorsSettingsSection } from './CorsSettingsSection';

function makeClient() {
  const settings: TenantCorsSettings = {
    id: 'current',
    enabled: true,
    routing_ready: true,
    revision: 0,
    origins: [],
    credentials: true,
  };
  const get = vi.fn().mockResolvedValue(settings);
  const patch = vi.fn().mockResolvedValue(settings);
  const client = {
    service: () => ({ get, patch }),
  } as unknown as AgorClient;
  return { client, get, patch };
}

function renderSection(client: AgorClient) {
  return render(
    <AntdApp>
      <CorsSettingsSection client={client} />
    </AntdApp>
  );
}

describe('CorsSettingsSection origin validation', () => {
  it('validates an incomplete origin while the user types', async () => {
    const { client } = makeClient();
    renderSection(client);

    const input = await screen.findByPlaceholderText('https://app.example.com');
    fireEvent.change(input, { target: { value: 'app.example.com' } });

    expect(await screen.findByText('Origin must include http:// or https://')).toBeInTheDocument();
  });

  it('normalizes valid origins and rejects normalized duplicates', async () => {
    const { client } = makeClient();
    renderSection(client);

    const input = await screen.findByPlaceholderText('https://app.example.com');
    fireEvent.change(input, { target: { value: 'HTTPS://APP.EXAMPLE.COM:443/' } });
    fireEvent.click(screen.getByRole('button', { name: /add origin/i }));

    expect(await screen.findByText('https://app.example.com')).toBeInTheDocument();

    const resetInput = screen.getByPlaceholderText('https://app.example.com');
    fireEvent.change(resetInput, { target: { value: 'https://app.example.com/' } });
    expect(await screen.findByText('This origin is already listed')).toBeInTheDocument();
  });
});
