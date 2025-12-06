/**
 * MCP Session Tokens
 *
 * Simple token generation and validation for MCP authentication.
 * Tokens are session-specific and map to a user + session.
 */

import { randomBytes } from 'node:crypto';
import type { Application } from '@agor/core/feathers';
import type { SessionID, UserID } from '@agor/core/types';

interface SessionTokenData {
  userId: UserID;
  sessionId: SessionID;
  createdAt: number;
}

/**
 * In-memory token store
 * TODO: Move to database for production
 */
const tokenStore = new Map<string, SessionTokenData>();

/**
 * Reverse lookup: session ID to token
 */
const sessionToTokenStore = new Map<SessionID, string>();

/**
 * Generate a session token for MCP access
 *
 * @param userId - User ID
 * @param sessionId - Session ID
 * @returns Session token string
 */
export function generateSessionToken(userId: UserID, sessionId: SessionID): string {
  // Generate random token
  const token = randomBytes(32).toString('hex');

  // Store token data
  tokenStore.set(token, {
    userId,
    sessionId,
    createdAt: Date.now(),
  });

  // Store reverse lookup
  sessionToTokenStore.set(sessionId, token);

  console.log(`🎫 Generated MCP session token for session ${sessionId.substring(0, 8)}`);

  return token;
}

/**
 * Validate a session token
 *
 * @param app - FeathersJS application instance
 * @param token - Session token to validate
 * @returns Token data if valid, null if invalid
 */
export async function validateSessionToken(
  app: Application,
  token: string
): Promise<SessionTokenData | null> {
  // Check in-memory store first (fast path)
  const memoryData = tokenStore.get(token);

  if (memoryData) {
    // Check if token is expired (24 hours)
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    if (Date.now() - memoryData.createdAt > maxAge) {
      tokenStore.delete(token);
      sessionToTokenStore.delete(memoryData.sessionId);
      return null;
    }
    return memoryData;
  }

  // Not in memory - check database (slow path, survives daemon restarts)
  // Query directly by mcp_token for O(1) lookup instead of loading all sessions
  try {
    const result = await app.service('sessions').find({
      query: { mcp_token: token, $limit: 1 },
      provider: undefined, // Internal call, bypass external-only hooks
    });

    const sessions = result.data || result;
    const session = Array.isArray(sessions) && sessions.length > 0 ? sessions[0] : null;

    if (session) {
      // Found in database - restore to memory
      const data: SessionTokenData = {
        userId: session.created_by as UserID,
        sessionId: session.session_id,
        createdAt: new Date(session.created_at).getTime(),
      };

      // Check if expired
      const maxAge = 24 * 60 * 60 * 1000;
      if (Date.now() - data.createdAt > maxAge) {
        return null;
      }

      // Restore to memory for future fast lookups
      tokenStore.set(token, data);
      sessionToTokenStore.set(session.session_id, token);

      console.log(
        `♻️  Restored MCP token from database for session ${session.session_id.substring(0, 8)}`
      );
      return data;
    }
  } catch (error) {
    console.error('Failed to check database for token:', error);
  }

  return null;
}

/**
 * Get token for a session
 *
 * @param sessionId - Session ID
 * @returns Token string if exists, undefined otherwise
 */
export function getTokenForSession(sessionId: SessionID): string | undefined {
  return sessionToTokenStore.get(sessionId);
}

/**
 * Revoke a session token
 *
 * @param token - Token to revoke
 */
export function revokeSessionToken(token: string): void {
  const data = tokenStore.get(token);
  if (data) {
    sessionToTokenStore.delete(data.sessionId);
  }
  tokenStore.delete(token);
}

/**
 * Clean up expired tokens (should be called periodically)
 */
export function cleanupExpiredTokens(): void {
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  const now = Date.now();

  for (const [token, data] of tokenStore.entries()) {
    if (now - data.createdAt > maxAge) {
      sessionToTokenStore.delete(data.sessionId);
      tokenStore.delete(token);
    }
  }
}
