/**
 * MCP Session Tokens (Deterministic JWT-based)
 *
 * Generates deterministic JWT tokens for internal MCP authentication.
 * Tokens are derived from session ID + user ID + daemon secret, making them:
 * - Reproducible (same session always gets same token)
 * - Stateless (no database or in-memory storage needed)
 * - Restart-safe (daemon restarts don't invalidate tokens)
 * - Session-scoped (each session has unique token)
 *
 * Security: Designed for internal localhost/same-workspace communication only.
 * Uses HS256 (HMAC-SHA256) with daemon's internal secret.
 */

import type { Application } from '@agor/core/feathers';
import type { SessionID, UserID } from '@agor/core/types';
import jwt from 'jsonwebtoken';

interface SessionTokenData {
  userId: UserID;
  sessionId: SessionID;
}

/**
 * Generate deterministic MCP session token for internal daemon communication.
 *
 * Uses JWT with HS256 algorithm and no timestamp (iat removed) to ensure
 * the same session+user always produces the same token.
 *
 * @param userId - User ID
 * @param sessionId - Session ID
 * @param daemonSecret - JWT secret from app settings
 * @returns Deterministic JWT token string
 */
export function generateSessionToken(
  userId: UserID,
  sessionId: SessionID,
  daemonSecret: string
): string {
  // Generate deterministic JWT (no timestamp for reproducibility)
  const token = jwt.sign(
    {
      sub: sessionId, // Subject = session ID
      uid: userId, // Custom claim for user
      aud: 'agor:mcp:internal', // Audience = internal MCP only
      // NO iat (issued at) - this ensures determinism
    },
    daemonSecret,
    {
      algorithm: 'HS256',
      noTimestamp: true, // Critical: makes token deterministic
    }
  );

  console.log(`🎫 Generated deterministic MCP token for session ${sessionId.substring(0, 8)}`);

  return token;
}

/**
 * Validate an MCP session token and extract session/user context.
 *
 * Verifies JWT signature and extracts sessionId + userId from claims.
 * No database lookup needed - validation is purely cryptographic.
 *
 * @param app - FeathersJS application instance (used to get JWT secret)
 * @param token - JWT token to validate
 * @returns Token data if valid, null if invalid or expired
 */
export async function validateSessionToken(
  app: Application,
  token: string
): Promise<SessionTokenData | null> {
  try {
    // Get JWT secret from app settings
    const jwtSecret = app.settings.authentication?.secret;
    if (!jwtSecret) {
      console.error('❌ JWT secret not configured in app settings');
      return null;
    }

    // Verify and decode JWT
    const payload = jwt.verify(token, jwtSecret, {
      audience: 'agor:mcp:internal',
      algorithms: ['HS256'],
    }) as {
      sub: SessionID;
      uid: UserID;
      aud: string;
    };

    // Extract session and user from claims
    return {
      sessionId: payload.sub,
      userId: payload.uid,
    };
  } catch (error) {
    // JWT verification failed (invalid signature, wrong audience, etc.)
    if (error instanceof jwt.JsonWebTokenError) {
      console.warn(`⚠️  Invalid MCP token: ${error.message}`);
    } else {
      console.error('❌ Token validation error:', error);
    }
    return null;
  }
}

/**
 * Get token for a session (generates deterministically).
 *
 * Since tokens are deterministic, we can always regenerate them
 * instead of looking them up.
 *
 * @param sessionId - Session ID
 * @param userId - User ID
 * @param daemonSecret - JWT secret
 * @returns Token string
 */
export function getTokenForSession(
  sessionId: SessionID,
  userId: UserID,
  daemonSecret: string
): string {
  return generateSessionToken(userId, sessionId, daemonSecret);
}

/**
 * Revoke a session token.
 *
 * Note: With deterministic tokens, we can't truly "revoke" a token
 * without maintaining a blocklist. For now, this is a no-op.
 *
 * True revocation would require:
 * 1. Maintaining a blocklist of revoked tokens in DB
 * 2. Checking blocklist during validation
 * 3. Or rotating the daemon secret (invalidates ALL tokens)
 *
 * @param token - Token to revoke (currently no-op)
 */
export function revokeSessionToken(token: string): void {
  console.warn(
    '⚠️  revokeSessionToken called but deterministic tokens cannot be revoked. ' +
      'To revoke access, delete the session or rotate the daemon secret.'
  );
  // No-op: deterministic tokens can't be revoked without a blocklist
}

/**
 * Clean up expired tokens.
 *
 * Note: With deterministic stateless tokens, there's nothing to clean up.
 * Token expiration would need to be implemented via JWT 'exp' claim if needed.
 *
 * Currently a no-op for backward compatibility.
 */
export function cleanupExpiredTokens(): void {
  // No-op: no in-memory storage to clean up
}
