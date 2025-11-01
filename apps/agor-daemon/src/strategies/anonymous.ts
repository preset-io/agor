/**
 * Anonymous Authentication Strategy
 *
 * Allows unauthenticated access when enabled in config.
 * Used for local-first development where authentication is optional.
 */

import { loadConfig } from '@agor/core/config';
import { AuthenticationBaseStrategy } from '@agor/core/feathers';
import type { AuthenticationResult, Params } from '@agor/core/types';

// NotAuthenticated error (simplified implementation)
class NotAuthenticated extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotAuthenticated';
  }
}

export class AnonymousStrategy extends AuthenticationBaseStrategy {
  /**
   * Authenticate anonymous request
   */
  async authenticate(
    _authentication: { strategy: string },
    _params: Params
  ): Promise<AuthenticationResult> {
    // Load config to check if anonymous access is allowed
    const config = await loadConfig();

    // Default to allowing anonymous (local-first mode)
    // Only block if explicitly set to false
    if (config.daemon?.allowAnonymous === false) {
      throw new NotAuthenticated('Anonymous access disabled');
    }

    // Return anonymous user with viewer privileges (read-only local mode)
    return {
      accessToken: '',
      authentication: { strategy: 'anonymous' },
      user: {
        user_id: 'anonymous',
        email: 'anonymous@localhost',
        role: 'viewer',
      },
    };
  }
}
