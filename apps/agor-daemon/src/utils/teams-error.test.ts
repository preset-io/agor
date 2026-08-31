import { describe, expect, it } from 'vitest';
import { TEAMS_GATEWAY_ERROR_CODES, teamsGatewayErrorCode } from './teams-error';

describe('Teams gateway error classification', () => {
  it('returns only finite content-free categories', () => {
    const secret = 'Bearer teams-secret-value';

    expect(teamsGatewayErrorCode(new Error(secret))).toBe('provider_request_failed');
    expect(teamsGatewayErrorCode({ status: 429, message: secret })).toBe('provider_rate_limited');
    expect(teamsGatewayErrorCode({ code: 'not-a-reviewed-code', message: secret })).toBe(
      'provider_request_failed'
    );
    expect(TEAMS_GATEWAY_ERROR_CODES).not.toContain(secret);
  });
});
