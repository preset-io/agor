import { describe, expect, it } from 'vitest';
import { GatewayListenerError, gatewayListenerFailure } from './listener-error';

describe('gatewayListenerFailure', () => {
  it('preserves reviewed permanent classifications and remediation', () => {
    const error = new GatewayListenerError('slack_bot_token_invalid', 'permanent', 'Replace it.');
    expect(gatewayListenerFailure(error)).toBe(error);
  });

  it('turns raw provider exceptions into a bounded transient category', () => {
    const failure = gatewayListenerFailure(
      new Error('request failed Authorization: Bearer secret user@example.test')
    );
    expect(failure).toMatchObject({ code: 'provider_unavailable', kind: 'transient' });
    expect(`${failure.code} ${failure.remediation}`).not.toMatch(/secret|@example/);
  });
});
