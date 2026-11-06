/**
 * Schedule trigger tokens.
 *
 * A trigger token can do exactly one thing: start a run of one schedule via
 * `POST /schedules/:id/trigger`. It is 256 random bits behind a recognizable
 * prefix so secret scanners can flag leaks. Only its sha256 is persisted: the
 * token has full entropy, so a slow KDF adds nothing, and a deterministic
 * digest lets the unauthenticated route discover the owning tenant by hash.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SCHEDULE_TRIGGER_TOKEN_PREFIX } from '@agor/core/types';

const TOKEN_RANDOM_BYTES = 32;

export function hashScheduleTriggerToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Mint a fresh token. The raw value is returned to the caller once and never stored. */
export function generateScheduleTriggerToken(): { token: string; tokenHash: string } {
  const token = `${SCHEDULE_TRIGGER_TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString('base64url')}`;
  return { token, tokenHash: hashScheduleTriggerToken(token) };
}

export function scheduleTriggerTokenHashesMatch(stored: string, presented: string): boolean {
  const a = Buffer.from(stored, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Extract a trigger token from `Authorization: Bearer agor_trg_…`, or null. */
export function parseScheduleTriggerBearer(
  headers: Record<string, unknown> | undefined
): string | null {
  const value = headers?.authorization;
  if (typeof value !== 'string') return null;
  const match = value.match(/^Bearer\s+(\S+)$/i);
  const token = match?.[1];
  return token?.startsWith(SCHEDULE_TRIGGER_TOKEN_PREFIX) ? token : null;
}
