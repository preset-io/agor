import { describe, expect, it } from 'vitest';
import {
  CODEX_LIFECYCLE_MESSAGES,
  EXECUTOR_LAUNCH_REFUSED_MESSAGE,
  failureMessageBase,
  GEMINI_API_KEY_REQUIRED_MESSAGE,
  isConnectionLossMessage,
  isMissingCredentialMessage,
  missingOpenCodeApiKeyMessage,
  missingScopedCredentialMessage,
  parsePermissionTimeoutMs,
  permissionTimeoutMessage,
  SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE,
  withProviderDetail,
} from './turn-failure-messages';

describe('isMissingCredentialMessage', () => {
  it('recognizes every missing-credential text an executor writes', () => {
    expect(isMissingCredentialMessage(missingScopedCredentialMessage('claude-code'))).toBe(true);
    expect(isMissingCredentialMessage(missingOpenCodeApiKeyMessage('anthropic'))).toBe(true);
    expect(isMissingCredentialMessage(GEMINI_API_KEY_REQUIRED_MESSAGE)).toBe(true);
    expect(
      isMissingCredentialMessage(
        'Codex subscription credentials are missing or unsafe to mount. Reconnect Codex in Agent Setup or use an API key.'
      )
    ).toBe(true);
    expect(isMissingCredentialMessage(CODEX_LIFECYCLE_MESSAGES.authentication_required)).toBe(true);
  });

  it('rejects other failures and an empty template fill', () => {
    expect(isMissingCredentialMessage(CODEX_LIFECYCLE_MESSAGES.turn_failed)).toBe(false);
    expect(isMissingCredentialMessage(missingScopedCredentialMessage(''))).toBe(false);
    expect(isMissingCredentialMessage('No scoped credential configured.')).toBe(false);
  });
});

describe('isConnectionLossMessage', () => {
  it.each([
    'socket has been disconnected',
    'operation has timed out',
    'unhandledRejection: socket has been disconnected',
    'uncaughtException: operation has timed out',
    'Error: socket has been disconnected',
  ])('recognizes the socket.io-client text %s', (text) => {
    expect(isConnectionLossMessage(text)).toBe(true);
  });

  it.each([
    'socket disconnected',
    'Codex failed the turn. Retry the prompt; review Codex authentication or runtime status if it continues.',
    'Executor heartbeat lost; the executor may have crashed or disconnected.',
  ])('rejects other text: %s', (text) => {
    expect(isConnectionLossMessage(text)).toBe(false);
  });
});

describe('permission timeout message', () => {
  it('round-trips the configured timeout and ignores anything else', () => {
    expect(parsePermissionTimeoutMs(permissionTimeoutMessage(600_000))).toBe(600_000);
    expect(parsePermissionTimeoutMs('Permission request timed out')).toBeUndefined();
    expect(parsePermissionTimeoutMs('Permission request timed out after msms.')).toBeUndefined();
  });
});

describe('provider detail', () => {
  it('keeps the fixed sentence first and recovers it for classification', () => {
    const stored = withProviderDetail(SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE, 'error_max_turns');
    expect(stored).toBe(
      'Agor could not confirm a successful response. Review any output and tool activity before retrying. Provider detail: error_max_turns'
    );
    expect(failureMessageBase(stored)).toBe(SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE);
    expect(failureMessageBase(`unhandledRejection: ${CODEX_LIFECYCLE_MESSAGES.turn_failed}`)).toBe(
      CODEX_LIFECYCLE_MESSAGES.turn_failed
    );
    expect(withProviderDetail('Fixed.', '  ')).toBe('Fixed.');
  });
});

describe('launch refused message', () => {
  it('is product-neutral, free of internal vocabulary, and a recognized fixed sentence', () => {
    expect(EXECUTOR_LAUNCH_REFUSED_MESSAGE).toBe(
      'Your team has reached its limit of work running at once. Wait for something to finish, then try again.'
    );
    // The turn outcome banner's banned vocabulary (describeTurnOutcome.test.ts).
    expect(EXECUTOR_LAUNCH_REFUSED_MESSAGE).not.toMatch(
      /executor|daemon|heartbeat|socket|SDK|containment|force-fail|\btasks?\b|\bturns?\b/i
    );
    expect(failureMessageBase(EXECUTOR_LAUNCH_REFUSED_MESSAGE)).toBe(
      EXECUTOR_LAUNCH_REFUSED_MESSAGE
    );
    expect(isMissingCredentialMessage(EXECUTOR_LAUNCH_REFUSED_MESSAGE)).toBe(false);
    expect(isConnectionLossMessage(EXECUTOR_LAUNCH_REFUSED_MESSAGE)).toBe(false);
  });
});
