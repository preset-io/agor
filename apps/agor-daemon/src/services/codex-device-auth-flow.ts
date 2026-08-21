/** State-free interpretation of the Codex device authorization protocol. */

import {
  type ApprovedCode,
  type CodexDeviceAuthProvider,
  DeviceAuthProviderError,
  type ExchangedTokens,
} from './codex-device-auth-provider.js';

export type CodexDevicePollDecision =
  | { outcome: 'retry'; intervalMs: number }
  | { outcome: 'denied' }
  | { outcome: 'expired' }
  | { outcome: 'failed' }
  | { outcome: 'approved'; approved: ApprovedCode };

/**
 * Interpret provider polling once without owning timers, leases, or attempt
 * state. Standalone and durable services apply the resulting decision through
 * their own authority mechanism.
 */
export async function pollCodexDeviceAuthorization(
  provider: CodexDeviceAuthProvider,
  input: { deviceAuthId: string; userCode: string; intervalMs: number }
): Promise<CodexDevicePollDecision> {
  let polled: Awaited<ReturnType<CodexDeviceAuthProvider['pollDeviceToken']>>;
  try {
    polled = await provider.pollDeviceToken(input.deviceAuthId, input.userCode);
  } catch (error) {
    return error instanceof DeviceAuthProviderError && error.disposition === 'terminal'
      ? { outcome: 'failed' }
      : { outcome: 'retry', intervalMs: input.intervalMs };
  }

  switch (polled.outcome) {
    case 'pending':
      return { outcome: 'retry', intervalMs: input.intervalMs };
    case 'slow_down':
      return {
        outcome: 'retry',
        intervalMs: input.intervalMs + polled.intervalIncreaseMs,
      };
    case 'denied':
      return { outcome: 'denied' };
    case 'expired':
      return { outcome: 'expired' };
    case 'approved':
      return { outcome: 'approved', approved: polled.approved };
  }
}

export type CodexDeviceExchangeDecision =
  | { outcome: 'tokens'; tokens: ExchangedTokens }
  | { outcome: 'failed'; certainty: 'definitive' | 'ambiguous' };

/** Classify the one-shot exchange once; callers must never retry ambiguity. */
export async function exchangeCodexDeviceAuthorization(
  provider: CodexDeviceAuthProvider,
  approved: ApprovedCode
): Promise<CodexDeviceExchangeDecision> {
  try {
    return { outcome: 'tokens', tokens: await provider.exchangeCodeForTokens(approved) };
  } catch (error) {
    const ambiguous =
      !(error instanceof DeviceAuthProviderError) || error.disposition === 'ambiguous';
    return {
      outcome: 'failed',
      certainty: ambiguous ? 'ambiguous' : 'definitive',
    };
  }
}
