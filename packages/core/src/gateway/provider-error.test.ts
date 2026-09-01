import { describe, expect, it } from 'vitest';
import { gatewayFailureCode, sanitizeGatewayProviderError } from './provider-error';

describe('sanitizeGatewayProviderError', () => {
  it('redacts token-shaped, URL, path, control, and oversized transport text', () => {
    const result = sanitizeGatewayProviderError(
      new Error(
        'xoxb-secret-123 Bearer abc.def https://provider.example.test/a /srv/agor/token\nunsafe ' +
          'x'.repeat(500)
      )
    );
    expect(result).not.toContain('xoxb-secret-123');
    expect(result).not.toContain('Bearer abc.def');
    expect(result).not.toContain('provider.example.test');
    expect(result).not.toContain('/srv/agor/token');
    expect(result).not.toContain('\n');
    expect(result.length).toBe(240);
    expect(result).toContain('[redacted]');
  });

  it('redacts a bare Discord token without redacting ordinary dotted diagnostics', () => {
    const token = `${'A'.repeat(24)}.${'B'.repeat(6)}.${'C'.repeat(27)}`;
    expect(sanitizeGatewayProviderError(new Error(`request failed ${token}`))).not.toContain(token);
    expect(
      sanitizeGatewayProviderError(new Error('diagnostic abc.def.ghi remains useful'))
    ).toContain('abc.def.ghi');
  });
});

describe('gatewayFailureCode', () => {
  it('returns stable categories without copying provider diagnostics', () => {
    expect(gatewayFailureCode({ status: 401, message: 'token https://secret.test/x' })).toBe(
      'provider_auth_failed'
    );
    expect(gatewayFailureCode({ statusCode: 429, message: 'rate limit' })).toBe(
      'provider_rate_limited'
    );
    expect(gatewayFailureCode({ kind: 'prompt_limit', message: 'raw provider text' })).toBe(
      'provider_history_prompt_limit'
    );
    expect(gatewayFailureCode(new Error('raw provider text /private/path'))).toBe(
      'provider_request_failed'
    );
  });
});
