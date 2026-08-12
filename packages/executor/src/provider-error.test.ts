import { describe, expect, it } from 'vitest';
import { buildSafeProviderFailureMessage } from './provider-error';

describe('buildSafeProviderFailureMessage', () => {
  it('replaces a quota provider body with safe classified state', () => {
    const unsafeBody = 'Credit balance is too low; account=provider-secret-body-marker';
    const result = buildSafeProviderFailureMessage(
      new Error(unsafeBody),
      `Agent SDK error: ${unsafeBody}`,
      'claude-code'
    );

    expect(result).toEqual({
      content: 'The model provider has no available credit or quota for this request.',
      metadata: {
        error_kind: 'provider_credit_exhausted',
        error_code: 'PROVIDER_CREDIT_EXHAUSTED',
        tool: 'claude-code',
      },
    });
    expect(JSON.stringify(result)).not.toContain('provider-secret-body-marker');
  });

  it('preserves a non-quota fallback and leaves missing credentials unclassified', () => {
    expect(
      buildSafeProviderFailureMessage(
        new Error('No scoped claude-code credential is configured'),
        'missing credential',
        'claude-code'
      )
    ).toEqual({ content: 'missing credential' });
  });
});
