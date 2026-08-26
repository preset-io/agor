import type {
  MCPMarketplaceAttachment,
  MCPMarketplaceCredential,
  MCPMarketplaceCredentialMethod,
  MCPMarketplaceServer,
} from '@agor/core/types';
import { shortId } from '@agor-live/client';

export type MarketplaceBadgeStatus = 'default' | 'success' | 'error' | 'warning' | 'processing';

export interface MarketplaceCredentialPresentation {
  label: string;
  badge: MarketplaceBadgeStatus;
  detail: string;
}

/** One production vocabulary for every caller-scoped Marketplace surface. */
export function marketplaceCredentialPresentation(
  credential?: MCPMarketplaceCredential,
  serverEnabled = true
): MarketplaceCredentialPresentation {
  if (!serverEnabled) {
    return {
      label: 'Disabled',
      badge: 'default',
      detail: 'This server is disabled. Disabling it does not revoke a saved connection.',
    };
  }

  if (!credential) {
    return {
      label: 'No account needed',
      badge: 'success',
      detail: 'This server is connected without a per-user account.',
    };
  }

  switch (credential.status) {
    case 'active':
      return {
        label: 'Connected',
        badge: 'success',
        detail: 'Your OAuth connection is active.',
      };
    case 'configured':
      return {
        label: 'Connected',
        badge: 'success',
        detail: 'Your credential is securely configured.',
      };
    case 'refreshable':
      return {
        label: 'Connected',
        badge: 'success',
        detail: 'Access will refresh securely when this server is used.',
      };
    case 'refreshing':
      return {
        label: 'Refreshing',
        badge: 'processing',
        detail: 'Agor is refreshing this connection. No new sign-in is needed.',
      };
    case 'reauthentication_required':
      return {
        label: 'Reconnect required',
        badge: 'error',
        detail: 'This saved grant cannot be used or refreshed. Sign in again.',
      };
    case 'not_connected':
      return {
        label: 'Sign-in required',
        badge: 'warning',
        detail: 'No active connection is recorded.',
      };
    default:
      // The daemon contract is exhaustive. A defensive runtime fallback avoids
      // ever leaking a newly-added database enum directly into user-facing UI.
      return {
        label: 'Needs attention',
        badge: 'warning',
        detail: 'This connection has a status this version of Agor cannot interpret.',
      };
  }
}

export function marketplaceCredentialMethodLabel(method: MCPMarketplaceCredentialMethod): string {
  switch (method) {
    case 'oauth':
      return 'OAuth';
    case 'bearer':
      return 'API key';
    case 'jwt':
      return 'JWT';
    default:
      return 'Credential';
  }
}

export function marketplaceCredentialActionLabel(
  credential: MCPMarketplaceCredential,
  serverEnabled = true
): 'Connect' | 'Reconnect' | 'Settings' {
  if (!serverEnabled) return 'Settings';
  if (credential.method === 'oauth') {
    if (credential.status === 'reauthentication_required') return 'Reconnect';
    if (credential.status === 'not_connected') return 'Connect';
    return 'Settings';
  }
  // Marketplace settings owns the existing secure editor. Do not promise a
  // one-click rotation when the action opens a form that can edit or clear it.
  return credential.status === 'configured' ? 'Settings' : 'Connect';
}

export function marketplaceCredentialNeedsRecovery(
  credential: MCPMarketplaceCredential,
  serverEnabled = true
): boolean {
  return (
    serverEnabled &&
    credential.method === 'oauth' &&
    (credential.status === 'not_connected' || credential.status === 'reauthentication_required')
  );
}

export function marketplaceCredentialIsUsable(credential: MCPMarketplaceCredential): boolean {
  return (
    credential.status === 'active' ||
    credential.status === 'refreshable' ||
    credential.status === 'refreshing' ||
    credential.status === 'configured'
  );
}

export function marketplaceServerTitle(server: MCPMarketplaceServer): string {
  return server.display_name ?? server.name;
}

export function marketplaceCredentialServerTitle(credential: MCPMarketplaceCredential): string {
  return credential.server_display_name ?? credential.server_name;
}

export function marketplaceSessionTitle(attachment: MCPMarketplaceAttachment): string {
  return attachment.session_title || shortId(attachment.session_id);
}

export function formatMarketplaceDate(value?: string, includeTime = false): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return includeTime ? date.toLocaleString() : date.toLocaleDateString();
}
