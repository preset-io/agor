import {
  OAuthCallbackValidationError,
  OAuthCodeExchangeError,
} from '@agor/core/tools/mcp/oauth-mcp-transport';
import { describe, expect, it } from 'vitest';
import {
  classifyMCPOAuthCompletionFailure,
  OAuthFlowAuthorizationChangedError,
} from './mcp-oauth-exchange-classification';

describe('classifyMCPOAuthCompletionFailure', () => {
  it.each([
    'callback_state_mismatch',
    'callback_issuer_missing',
    'callback_issuer_mismatch',
  ] as const)('persists %s as failed rather than ambiguous', (failureCode) => {
    expect(
      classifyMCPOAuthCompletionFailure(new OAuthCallbackValidationError(failureCode))
    ).toEqual({ status: 'failed', ambiguous: false, failureCode });
  });

  it('keeps an unknown post-claim crash outcome ambiguous', () => {
    expect(classifyMCPOAuthCompletionFailure(new Error('socket reset'))).toEqual({
      status: 'ambiguous',
      ambiguous: true,
      failureCode: 'exchange_outcome_ambiguous',
    });
  });

  it('preserves known provider rejection and role/config recheck semantics', () => {
    expect(
      classifyMCPOAuthCompletionFailure(
        new OAuthCodeExchangeError('rejected', false, 'provider_rejected')
      )
    ).toEqual({ status: 'failed', ambiguous: false, failureCode: 'provider_rejected' });
    expect(
      classifyMCPOAuthCompletionFailure(
        new OAuthCodeExchangeError('stale client', false, 'client_registration_invalidated', true)
      )
    ).toEqual({
      status: 'failed',
      ambiguous: false,
      failureCode: 'client_registration_invalidated',
    });
    expect(
      classifyMCPOAuthCompletionFailure(new OAuthFlowAuthorizationChangedError(false))
    ).toEqual({ status: 'failed', ambiguous: false, failureCode: 'authorization_changed' });
    expect(classifyMCPOAuthCompletionFailure(new OAuthFlowAuthorizationChangedError(true))).toEqual(
      {
        status: 'ambiguous',
        ambiguous: true,
        failureCode: 'exchange_outcome_ambiguous',
      }
    );
  });
});
