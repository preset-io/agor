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
    const oauth = (
      detailStatus: NonNullable<MCPMarketplaceCredential['detail_status']>
    ): MCPMarketplaceCredential => ({
      mcp_server_id: 'server-1',
      server_name: 'server',
      method: 'oauth',
      status:
        detailStatus === 'refreshing' || detailStatus === 'reauthentication_required'
          ? 'attention'
          : detailStatus === 'refreshable'
            ? 'expired'
            : detailStatus,
      detail_status: detailStatus,
    });

    expect(marketplaceCredentialActionLabel(oauth('reauthentication_required'))).toBe('Reconnect');
    expect(marketplaceCredentialActionLabel(oauth('not_connected'))).toBe('Connect');
    for (const status of ['active', 'refreshable', 'refreshing'] as const) {
      expect(marketplaceCredentialActionLabel(oauth(status))).toBe('Settings');
    }
  });

  it('states that disabling an OAuth server removes the saved grant', () => {
    const credential: MCPMarketplaceCredential = {
      mcp_server_id: 'server-1',
      server_name: 'server',
      method: 'oauth',
      status: 'active',
    };
    expect(marketplaceCredentialPresentation(credential, false)).toMatchObject({
      label: 'Disabled',
      badge: 'default',
      detail: expect.stringMatching(/removes its saved OAuth connection/i),
    });
    expect(marketplaceCredentialActionLabel(credential, false)).toBe('Settings');
  });

  it('qualifies a stored bearer credential without claiming provider verification', () => {
    const credential: MCPMarketplaceCredential = {
      mcp_server_id: 'server-1',
      server_name: 'server',
      method: 'bearer',
      status: 'configured',
    };
    expect(marketplaceCredentialPresentation(credential)).toEqual({
      label: 'Credential stored',
      badge: 'default',
      detail:
        'Your credential is stored securely. The remote provider verifies it when this server is used.',
    });
  });

  it('returns a safe dash for absent or invalid dates', () => {
    expect(formatMarketplaceDate()).toBe('—');
    expect(formatMarketplaceDate('not-a-date')).toBe('—');
  });
});
