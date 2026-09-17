import { describe, expect, it } from 'vitest';
import valid from '../../../../packages/core/src/tools/mcp/__fixtures__/managed-v1/valid.json';
import { managedOAuthFailureCode } from './mcp-oauth-managed-errors.js';

describe('managed refresh failure disclosure', () => {
  it('never turns arbitrary provider/network messages into revocation', () => {
    expect(managedOAuthFailureCode(new Error('invalid_grant SENTINEL_SECRET'))).toBe(
      'managed_authority_unavailable'
    );
    expect(managedOAuthFailureCode({ code: 'invalid_grant', token: 'SENTINEL_SECRET' })).toBe(
      'managed_authority_unavailable'
    );
  });
  it('distinguishes the certified app-client rejection from grant invalidation', () => {
    const {
      tokens: _tokens,
      signed_receipt: _receipt,
      use_authorization: _use,
      ...base
    } = valid.succeeded;
    // Strict outcome schemas refuse success-only receipt/token fields on failures.
    const outcome = {
      protocol_version: base.protocol_version,
      operation_id: base.operation_id,
      owner: base.owner,
      claim: base.claim,
      status: 'client_configuration_failed',
      failure_code: 'client_configuration_failed',
      sequence: base.sequence,
      next_sequence: base.next_sequence,
    };
    const error = Object.assign(new Error('SENTINEL_SECRET'), {
      name: 'ManagedMCPOAuthOperationError',
      outcome,
    });
    expect(managedOAuthFailureCode(error)).toBe('client_configuration_failed');
    expect(managedOAuthFailureCode(Object.assign(new Error(), { name: 'InvalidGrantError' }))).toBe(
      'needs_reauth'
    );
    expect(
      managedOAuthFailureCode(Object.assign(new Error(), { name: 'AmbiguousRefreshError' }))
    ).toBe('provider_outcome_ambiguous');
  });
});
