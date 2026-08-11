import {
  OAuthCallbackValidationError,
  OAuthCodeExchangeError,
} from '@agor/core/tools/mcp/oauth-mcp-transport';

/** Current role/configuration changed while a durable attempt was in flight. */
export class OAuthFlowAuthorizationChangedError extends Error {
  constructor(readonly afterProviderExchange = false) {
    super('MCP OAuth authorization must be restarted');
    this.name = 'OAuthFlowAuthorizationChangedError';
  }
}

export interface MCPOAuthCompletionFailure {
  status: 'failed' | 'ambiguous';
  ambiguous: boolean;
  failureCode: string;
}

/**
 * Keep callback and manual-completion durability semantics identical.
 * Unknown post-claim failures remain ambiguous; typed callback validation is
 * known to occur before token-endpoint I/O and is therefore a normal failure.
 */
export function classifyMCPOAuthCompletionFailure(error: unknown): MCPOAuthCompletionFailure {
  if (error instanceof OAuthCallbackValidationError) {
    return { status: 'failed', ambiguous: false, failureCode: error.failureCode };
  }
  if (error instanceof OAuthFlowAuthorizationChangedError && !error.afterProviderExchange) {
    return { status: 'failed', ambiguous: false, failureCode: 'authorization_changed' };
  }
  if (error instanceof OAuthCodeExchangeError) {
    return {
      status: error.ambiguous ? 'ambiguous' : 'failed',
      ambiguous: error.ambiguous,
      failureCode: error.failureCode,
    };
  }
  return {
    status: 'ambiguous',
    ambiguous: true,
    failureCode: 'exchange_outcome_ambiguous',
  };
}
