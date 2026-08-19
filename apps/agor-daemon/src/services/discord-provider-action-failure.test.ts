import {
  DiscordDeliveryCoordinateError,
  DiscordNonceRecoveryIncompleteError,
} from '@agor/core/gateway';
import { describe, expect, it } from 'vitest';
import { classifyDiscordProviderActionFailure } from './discord-provider-action-failure.js';

describe('classifyDiscordProviderActionFailure', () => {
  it('honors @discordjs/rest millisecond retryAfter and Discord JSON seconds', () => {
    expect(classifyDiscordProviderActionFailure({ status: 429, retryAfter: 2_500 }, 1)).toEqual({
      outcome: 'retry',
      errorCode: 'discord_rate_limited',
      retryAfterMs: 2_500,
    });
    expect(
      classifyDiscordProviderActionFailure({ status: 429, rawError: { retry_after: 1.25 } }, 1)
    ).toEqual({
      outcome: 'retry',
      errorCode: 'discord_rate_limited',
      retryAfterMs: 1_250,
    });
  });

  it('separates permanent auth, permission, and content failures from retryable transport errors', () => {
    expect(classifyDiscordProviderActionFailure({ status: 401 }, 1)).toEqual({
      outcome: 'dead_letter',
      errorCode: 'discord_auth_rejected',
    });
    expect(classifyDiscordProviderActionFailure({ rawError: { code: 50013 } }, 1)).toEqual({
      outcome: 'dead_letter',
      errorCode: 'discord_permission_rejected',
    });
    expect(classifyDiscordProviderActionFailure({ status: 400 }, 1)).toEqual({
      outcome: 'dead_letter',
      errorCode: 'discord_content_or_target_rejected',
    });
    expect(classifyDiscordProviderActionFailure({ status: 503 }, 2, 0.5)).toMatchObject({
      outcome: 'retry',
      errorCode: 'discord_server_error',
    });
  });

  it('dead-letters bounded nonce searches that cannot prove absence', () => {
    expect(
      classifyDiscordProviderActionFailure(new DiscordNonceRecoveryIncompleteError(), 2)
    ).toEqual({
      outcome: 'dead_letter',
      errorCode: 'discord_nonce_recovery_incomplete',
    });
  });

  it('dead-letters a recovered/returned coordinate that conflicts with the frozen chunk', () => {
    expect(classifyDiscordProviderActionFailure(new DiscordDeliveryCoordinateError(), 1)).toEqual({
      outcome: 'dead_letter',
      errorCode: 'discord_delivery_coordinate_conflict',
    });
  });
});
