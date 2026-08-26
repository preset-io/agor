import type { MCPMarketplaceCredential } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  formatMarketplaceDate,
  marketplaceCredentialActionLabel,
  marketplaceCredentialMethodLabel,
  marketplaceCredentialPresentation,
} from './marketplacePresentation';

describe('Marketplace presentation vocabulary', () => {
  it('describes healthy open servers without implying missing status', () => {
    expect(marketplaceCredentialPresentation()).toEqual({
      label: 'No account needed',
      badge: 'success',
      detail: 'This server is connected without a per-user account.',
    });
  });

  it('never echoes an unknown credential status or method', () => {
    const unknown = {
      mcp_server_id: 'server-1',
      server_name: 'server',
      method: 'database_enum_value',
      status: 'raw_database_enum',
    } as unknown as MCPMarketplaceCredential;

    expect(marketplaceCredentialPresentation(unknown).label).toBe('Needs attention');
    expect(marketplaceCredentialPresentation(unknown).label).not.toContain('raw_database_enum');
    expect(marketplaceCredentialMethodLabel(unknown.method)).toBe('Credential');
  });

  it('offers reconnect only when the OAuth grant must be replaced', () => {
    const oauth = (status: MCPMarketplaceCredential['status']): MCPMarketplaceCredential => ({
      mcp_server_id: 'server-1',
      server_name: 'server',
      method: 'oauth',
      status,
    });

    expect(marketplaceCredentialActionLabel(oauth('reauthentication_required'))).toBe('Reconnect');
    expect(marketplaceCredentialActionLabel(oauth('not_connected'))).toBe('Connect');
    for (const status of ['active', 'refreshable', 'refreshing'] as const) {
      expect(marketplaceCredentialActionLabel(oauth(status))).toBe('Settings');
    }
  });

  it('presents disabled state separately without revoking a healthy OAuth grant', () => {
    const credential: MCPMarketplaceCredential = {
      mcp_server_id: 'server-1',
      server_name: 'server',
      method: 'oauth',
      status: 'active',
    };
    expect(marketplaceCredentialPresentation(credential, false)).toMatchObject({
      label: 'Disabled',
      badge: 'default',
    });
    expect(marketplaceCredentialActionLabel(credential, false)).toBe('Settings');
  });

  it('returns a safe dash for absent or invalid dates', () => {
    expect(formatMarketplaceDate()).toBe('—');
    expect(formatMarketplaceDate('not-a-date')).toBe('—');
  });
});
