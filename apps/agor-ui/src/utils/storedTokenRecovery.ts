/**
 * Stored-credential recovery for raw `fetch` callers.
 *
 * Feathers clients recover from expired access tokens on their own (socket
 * handshake recovery in useAgorClient, proactive refresh in useAuth). Raw
 * `fetch` requests that read the stored bearer — multipart uploads, for
 * example — use these helpers instead of rolling their own refresh rules.
 *
 * localStorage is shared by every tab, so a stored credential can change
 * owner mid-request (another tab signs in as someone else). Recovery is
 * therefore pinned to the identity of the token the request started with:
 * a refresh that comes back as a different user or tenant is discarded, so a
 * request is never replayed under an identity that did not initiate it.
 */

import { createRestClient } from '@agor-live/client';
import { readUnverifiedJwtPayload } from '@agor-live/client/jwt';
import { refreshTokensSingleFlight } from './singleFlightRefresh';
import { getStoredRefreshToken } from './tokenRefresh';

/** Identity claims a recovered credential must match. Hints only, never authority. */
export interface StoredCredentialOwner {
  subject: string;
  tenantId: string | null;
}

function ownerOf(token: string): StoredCredentialOwner | null {
  const payload = readUnverifiedJwtPayload(token);
  if (typeof payload?.sub !== 'string' || !payload.sub) return null;
  return {
    subject: payload.sub,
    tenantId: typeof payload.tenant_id === 'string' ? payload.tenant_id : null,
  };
}

/** Pin the identity of the access token a request is about to use. */
export function readStoredCredentialOwner(
  accessToken: string | null | undefined
): StoredCredentialOwner | null {
  return accessToken ? ownerOf(accessToken) : null;
}

/**
 * Refresh the stored credentials through the shared single-flight refresh
 * and return the new access token only if it still belongs to `owner`.
 * Returns null when no refresh is possible, it fails, or the identity
 * changed; the caller then surfaces its original authentication failure.
 * Unrecoverable refresh failures are already handled centrally (useAuth).
 */
export async function refreshStoredAccessTokenForOwner(
  daemonUrl: string,
  owner: StoredCredentialOwner
): Promise<string | null> {
  const refreshToken = getStoredRefreshToken();
  if (!refreshToken) return null;
  try {
    const client = await createRestClient(daemonUrl);
    const { accessToken } = await refreshTokensSingleFlight(client, refreshToken);
    const refreshedOwner = ownerOf(accessToken);
    return refreshedOwner?.subject === owner.subject && refreshedOwner.tenantId === owner.tenantId
      ? accessToken
      : null;
  } catch {
    return null;
  }
}
