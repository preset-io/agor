/**
 * Session Token Authentication Strategy
 *
 * Custom Feathers authentication strategy for executor session tokens.
 * Session tokens are opaque UUIDs (not JWTs) managed by SessionTokenService.
 */

import { AuthenticationBaseStrategy } from '@agor/core/feathers';
import type { AuthenticationResult, Params } from '@agor/core/types';
import type { SessionTokenService } from '../services/session-token-service.js';

export class SessionTokenStrategy extends AuthenticationBaseStrategy {
  constructor(private sessionTokenService: SessionTokenService) {
    super();
  }

  /**
   * Parse session token from request
   * Called by Feathers to extract authentication data from requests
   *
   * IMPORTANT: This method is called to determine if this strategy can handle the request.
   * Only return authentication data if this is a session-token request.
   */
  async parse(req: unknown): Promise<{ sessionToken: string } | null> {
    // For Socket.io connections, the authentication is stored in socket.feathers.authentication
    const socket = req as {
      id?: string;
      feathers?: {
        authentication?: {
          strategy?: string;
          accessToken?: string;
        };
      };
    };

    const auth = socket?.feathers?.authentication;

    // WORKAROUND: Also check socket.handshake.auth for the initial token
    const handshake = (socket as { handshake?: { auth?: { sessionToken?: string } } })?.handshake;
    const handshakeToken = handshake?.auth?.sessionToken;

    // Debug logging to see what we're receiving
    console.log('[SessionTokenStrategy] parse() called:', {
      socketId: socket?.id,
      hasFeathers: !!socket?.feathers,
      feathersKeys: socket?.feathers ? Object.keys(socket.feathers) : [],
      hasAuth: !!auth,
      strategy: auth?.strategy,
      hasToken: !!auth?.accessToken,
      tokenPreview: auth?.accessToken?.substring(0, 8),
      hasHandshakeToken: !!handshakeToken,
      socketRef: socket === req ? 'same' : 'different',
    });

    // Check if this looks like a session token (UUID format)
    // Session tokens are UUIDs with dashes, JWTs are base64 strings with dots
    const token = auth?.accessToken || handshakeToken;
    const hasSessionToken = token?.includes('-') && !token.includes('.');

    // Only parse if we have a UUID-format token
    if (hasSessionToken && token) {
      console.log('[SessionTokenStrategy] parse() returning session token (UUID format detected)');
      return { sessionToken: token };
    }

    if (auth?.strategy === 'session-token' && auth?.accessToken) {
      console.log('[SessionTokenStrategy] parse() returning session token (strategy match)');
      return { sessionToken: auth.accessToken };
    }

    console.log('[SessionTokenStrategy] parse() returning null (not session-token)');
    return null;
  }

  async authenticate(
    authentication: { sessionToken: string },
    params: Params
  ): Promise<AuthenticationResult> {
    console.log('[SessionTokenStrategy] authenticate() CALLED with:', {
      authKeys: Object.keys(authentication || {}),
      authentication: authentication,
    });

    const { sessionToken } = authentication;

    if (!sessionToken) {
      console.log('[SessionTokenStrategy] authenticate() FAILED: no token');
      throw new Error('No session token provided');
    }

    // Validate token via SessionTokenService
    const sessionInfo = await this.sessionTokenService.validateToken(sessionToken);

    if (!sessionInfo) {
      throw new Error('Invalid or expired session token');
    }

    // CRITICAL FIX: Manually store authentication on socket IMMEDIATELY
    // Feathers doesn't store it automatically for custom strategies
    // We must do this BEFORE returning so subsequent requests can use it
    if (params?.connection) {
      const socket = params.connection as {
        id?: string;
        feathers?: { authentication?: { strategy?: string; accessToken?: string } };
      };
      const socketId = socket.id || 'unknown';

      if (!socket.feathers) {
        socket.feathers = {};
      }
      socket.feathers.authentication = {
        strategy: 'session-token',
        accessToken: sessionToken,
      };
      console.log('[SessionTokenStrategy] ✅ Stored auth on socket during authenticate():', {
        socketId,
        storedStrategy: socket.feathers.authentication.strategy,
        storedTokenPreview: socket.feathers.authentication.accessToken?.substring(0, 8),
      });
    }

    // Return authentication result with user object
    // Must match the format Feathers expects for storing authentication
    const result = {
      authentication: {
        strategy: 'session-token',
      },
      accessToken: sessionToken, // Pass through the session token
      user: {
        user_id: sessionInfo.user_id,
        email: '',
        role: 'member', // Default role for session token auth
      },
      // Include session_id for downstream services
      session_id: sessionInfo.session_id,
    };

    console.log('[SessionTokenStrategy] authenticate() returning:', {
      strategy: result.authentication.strategy,
      tokenPreview: result.accessToken.substring(0, 8),
      user_id: sessionInfo.user_id,
    });

    return result;
  }

  /**
   * Verify access token on subsequent requests
   * Called by Feathers authentication to validate stored tokens
   */
  async verifyAccessToken(accessToken: string): Promise<AuthenticationResult> {
    console.log('[SessionTokenStrategy] verifyAccessToken() called:', {
      tokenPreview: accessToken?.substring(0, 8),
    });

    // Session tokens are opaque UUIDs, not JWTs
    // Validate via SessionTokenService instead of JWT verification
    const sessionInfo = await this.sessionTokenService.validateToken(accessToken);

    if (!sessionInfo) {
      console.log('[SessionTokenStrategy] verifyAccessToken() FAILED: invalid token');
      throw new Error('Invalid or expired session token');
    }

    console.log('[SessionTokenStrategy] verifyAccessToken() SUCCESS');
    return {
      authentication: {
        strategy: 'session-token',
      },
      accessToken,
      user: {
        user_id: sessionInfo.user_id,
        email: '',
        role: 'member', // Default role for session token auth
      },
      session_id: sessionInfo.session_id,
    };
  }

  /**
   * Get entity (user) for authentication
   * Override to skip database lookup since we already have user info from token
   */
  async getEntity(id: string): Promise<unknown> {
    console.log('[SessionTokenStrategy] getEntity() called:', { user_id: id });
    // Session tokens already include user_id, so we return a minimal user object
    // This prevents Feathers from trying to lookup the user in the database
    const user = {
      user_id: id,
      email: '',
    };
    console.log('[SessionTokenStrategy] getEntity() returning:', user);
    return user;
  }
}
