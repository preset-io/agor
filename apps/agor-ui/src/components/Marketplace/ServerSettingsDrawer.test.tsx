import type { MCPMarketplaceCredential, MCPMarketplaceServer } from '@agor/core/types';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ServerSettingsDrawer, type ServerSettingsDrawerProps } from './ServerSettingsDrawer';

const SERVER = {
  mcp_server_id: 'server-1',
  name: 'hubspot',
  display_name: 'HubSpot',
  source: 'catalog',
  transport: 'http',
  catalog_entry_name: 'com.hubspot/mcp',
  enabled: true,
  tools: [],
  session_count: 0,
  created_at: '2026-10-09T00:00:00.000Z',
  updated_at: '2026-10-09T00:00:00.000Z',
} as unknown as MCPMarketplaceServer;

const CREDENTIAL = {
  mcp_server_id: 'server-1',
  server_name: 'hubspot',
  method: 'oauth',
  status: 'active',
} as unknown as MCPMarketplaceCredential;

function props(overrides: Partial<ServerSettingsDrawerProps> = {}): ServerSettingsDrawerProps {
  return {
    server: SERVER,
    credential: CREDENTIAL,
    connection: { label: 'Connected', badge: 'success', detail: '' },
    attachments: [],
    cursorAttached: false,
    canRefresh: true,
    canChangeTools: true,
    canReconnect: true,
    canRemove: true,
    busy: new Set(),
    onClose: vi.fn(),
    onAfterOpenChange: vi.fn(),
    onRefreshTools: vi.fn(),
    onToggleTool: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  };
}

describe('ServerSettingsDrawer OAuth app editing', () => {
  it('offers the OAuth app editor for a customer-owned app install', () => {
    const onEditOAuthApp = vi.fn();
    render(<ServerSettingsDrawer {...props({ onEditOAuthApp })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit HubSpot OAuth app credentials' }));
    expect(onEditOAuthApp).toHaveBeenCalledOnce();
  });

  it('shows no editor when the install is not a customer-owned app the caller may edit', () => {
    render(<ServerSettingsDrawer {...props()} />);
    expect(screen.queryByRole('button', { name: 'Edit HubSpot OAuth app credentials' })).toBeNull();
  });

  it('disables the editor without edit permission', () => {
    render(<ServerSettingsDrawer {...props({ onEditOAuthApp: vi.fn(), canChangeTools: false })} />);
    expect(
      screen.getByRole('button', { name: 'Edit HubSpot OAuth app credentials' })
    ).toHaveProperty('disabled', true);
  });
});
