/**
 * Token refresh utilities for authentication
 *
 * Centralizes the logic for refreshing JWT tokens using refresh tokens.
 * Used by both useAuth and useAgorClient hooks to avoid duplication.
 */

import type { AgorClient } from '@agor/core/api';

export const ACCESS_TOKEN_KEY = 'agor-access-token';
export const REFRESH_TOKEN_KEY = 'agor-refresh-token';

export interface RefreshResult {
  accessToken: string;
  refreshToken?: string;
  user: {
    user_id: string;
    email: string;
    name?: string;
    emoji?: string;
    role: string;
  };
}

/**
 * Refresh access token using refresh token
 *
 * @param client - Agor client instance
 * @param refreshToken - Current refresh token
 * @returns New access token, optional new refresh token, and user info
 */
export async function refreshAccessToken(
  client: AgorClient,
  refreshToken: string
): Promise<RefreshResult> {
  const result = await client.service('authentication/refresh').create({
    refreshToken,
  });

  return result as RefreshResult;
}

/**
 * Store authentication tokens in localStorage
 *
 * @param accessToken - Access token to store
 * @param refreshToken - Optional refresh token to store (if rotated)
 */
export function storeTokens(accessToken: string, refreshToken?: string): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  if (refreshToken) {
    localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  }
}

/**
 * Get stored refresh token from localStorage
 *
 * @returns Refresh token or null if not found
 */
export function getStoredRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

/**
 * Get stored access token from localStorage
 *
 * @returns Access token or null if not found
 */
export function getStoredAccessToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

/**
 * Clear all authentication tokens from localStorage
 */
export function clearTokens(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

/**
 * Refresh and store tokens in one operation
 *
 * Convenience function that combines refreshAccessToken and storeTokens.
 *
 * @param client - Agor client instance
 * @param refreshToken - Current refresh token
 * @returns Refresh result with new tokens and user info
 */
export async function refreshAndStoreTokens(
  client: AgorClient,
  refreshToken: string
): Promise<RefreshResult> {
  const result = await refreshAccessToken(client, refreshToken);
  storeTokens(result.accessToken, result.refreshToken);
  return result;
}
