import { describe, expect, it } from 'vitest';
import { sanitizeGatewayProviderError } from './provider-error';

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
