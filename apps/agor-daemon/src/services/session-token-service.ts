/**
 * SessionTokenService - Manages secure session tokens for executor authentication
 *
 * Session tokens are JWTs that:
 * - Map to a specific session and user (via payload)
 * - Expire after configured time (default: 24 hours)
 * - Work seamlessly with Feathers JWT authentication
 * - Can be revoked by tracking active tokens
 *
 * This service generates JWTs instead of opaque UUIDs to work with Feathers'
 * built-in JWT authentication infrastructure, avoiding the complexity of custom strategies.
 */

import jwt from 'jsonwebtoken';

interface SessionTokenData {
  session_id: string;
  user_id: string;
  created_at: Date;
  expires_at: Date;
  max_uses: number;
  use_count: number;
}

interface SessionInfo {
  session_id: string;
  user_id: string;
}

export class SessionTokenService {
  private tokens = new Map<string, SessionTokenData>();
  private jwtSecret: string | null = null;

  constructor(
    private config: {
      expiration_ms: number; // Default: 86400000 (24 hours)
      max_uses: number; // Default: -1 (unlimited)
    }
  ) {
    // Start cleanup timer (run every hour)
    this.startCleanupTimer();
  }

  /**
   * Set the JWT secret (needed for JWT generation)
   * Must be called after authentication is configured
   */
  setJwtSecret(secret: string): void {
    this.jwtSecret = secret;
  }

  /**
   * Generate a new session token (JWT)
   * Returns a JWT that works with Feathers' standard JWT authentication
   */
  async generateToken(sessionId: string, userId: string): Promise<string> {
    if (!this.jwtSecret) {
      throw new Error('SessionTokenService: JWT secret not set. Call setJwtSecret() first.');
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.expiration_ms);

    // Create a JWT payload matching Feathers authentication format
    // This JWT will work seamlessly with the standard JWT strategy
    const payload = {
      sub: userId, // Standard JWT subject claim (used by Feathers for user lookup)
      sessionId: sessionId, // Custom claim for session tracking
      iat: Math.floor(now.getTime() / 1000), // Issued at
      exp: Math.floor(expiresAt.getTime() / 1000), // Expiration
      aud: 'https://agor.dev', // Must match Feathers jwtOptions.audience
      iss: 'agor', // Must match Feathers jwtOptions.issuer
    };

    // Sign the JWT with the same secret and algorithm as Feathers
    // NOTE: We set exp in payload, so don't use expiresIn option
    const token = jwt.sign(payload, this.jwtSecret, {
      algorithm: 'HS256', // Must match Feathers jwtOptions.algorithm
      // No expiresIn here - we set exp directly in payload
    });

    // Track this token for revocation and use counting
    this.tokens.set(token, {
      session_id: sessionId,
      user_id: userId,
      created_at: now,
      expires_at: expiresAt,
      max_uses: this.config.max_uses,
      use_count: 0,
    });

    console.log(
      `[SessionTokenService] Generated JWT for session=${sessionId}, expires=${expiresAt.toISOString()}`
    );

    return token;
  }

  /**
   * Validate a session token and return session info
   * Returns null if token has been revoked or exceeded max uses
   *
   * NOTE: JWT signature/expiration validation is handled by Feathers automatically.
   * This method only checks revocation and use counting.
   */
  async validateToken(token: string): Promise<SessionInfo | null> {
    // Get tracking data for this token
    const data = this.tokens.get(token);

    if (!data) {
      // Token not in our tracking map - either never issued or already revoked
      console.warn(`[SessionTokenService] Token not found in tracking map`);
      return null;
    }

    // Check if token has been revoked (already expired tokens are removed from map)
    if (new Date() > data.expires_at) {
      console.warn(`[SessionTokenService] Token expired`);
      this.tokens.delete(token);
      return null;
    }

    // Check max uses (if configured)
    if (data.max_uses > 0 && data.use_count >= data.max_uses) {
      console.warn(`[SessionTokenService] Token max uses exceeded`);
      this.tokens.delete(token);
      return null;
    }

    // Increment use count
    data.use_count++;

    console.log(
      `[SessionTokenService] Token validated: session=${data.session_id}, uses=${data.use_count}/${data.max_uses === -1 ? '∞' : data.max_uses}`
    );

    return {
      session_id: data.session_id,
      user_id: data.user_id,
    };
  }

  /**
   * Revoke a session token
   */
  revokeToken(token: string): void {
    if (this.tokens.delete(token)) {
      console.log(`[SessionTokenService] Token revoked: ${token.slice(0, 8)}...`);
    }
  }

  /**
   * Revoke all tokens for a session
   */
  revokeSessionTokens(sessionId: string): void {
    let count = 0;

    for (const [token, data] of this.tokens.entries()) {
      if (data.session_id === sessionId) {
        this.tokens.delete(token);
        count++;
      }
    }

    if (count > 0) {
      console.log(`[SessionTokenService] Revoked ${count} tokens for session=${sessionId}`);
    }
  }

  /**
   * Get active token count
   */
  getActiveTokenCount(): number {
    return this.tokens.size;
  }

  /**
   * Clean up expired tokens (runs periodically)
   */
  private cleanupExpiredTokens(): void {
    const now = new Date();
    let count = 0;

    for (const [token, data] of this.tokens.entries()) {
      if (now > data.expires_at) {
        this.tokens.delete(token);
        count++;
      }
    }

    if (count > 0) {
      console.log(`[SessionTokenService] Cleaned up ${count} expired tokens`);
    }
  }

  /**
   * Start periodic cleanup timer
   */
  private startCleanupTimer(): void {
    // Clean up every hour
    setInterval(
      () => {
        this.cleanupExpiredTokens();
      },
      60 * 60 * 1000
    );
  }
}
