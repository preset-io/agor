/**
 * Cron helpers — focused on the tz argument added for first-class
 * schedules. The defaults preserve the pre-#1253 UTC-only behavior.
 */

import { describe, expect, it } from 'vitest';
import {
  getNextRunTime,
  isValidCron,
  resolveScheduleTz,
  roundToMinute,
  validateCron,
} from './cron';

describe('isValidCron', () => {
  it('accepts valid 5-field cron expressions', () => {
    expect(isValidCron('0 9 * * 1-5')).toBe(true);
    expect(isValidCron('*/5 * * * *')).toBe(true);
  });

  it('rejects garbage', () => {
    expect(isValidCron('not a cron')).toBe(false);
    expect(isValidCron('99 99 99 99 99')).toBe(false);
  });

  it('validates against a custom IANA timezone', () => {
    expect(isValidCron('0 9 * * *', 'America/Los_Angeles')).toBe(true);
    expect(isValidCron('0 9 * * *', 'Not_A_Zone')).toBe(false);
  });
});

describe('validateCron', () => {
  it('throws with a useful message on invalid cron', () => {
    expect(() => validateCron('bogus')).toThrow(/Invalid cron expression/);
  });
});

describe('getNextRunTime', () => {
  it('returns a future timestamp aligned to the cron expression in UTC by default', () => {
    // Pick a fixed "from" date so the test is deterministic.
    const from = new Date('2026-05-24T08:30:00Z');
    const next = getNextRunTime('0 9 * * *', from);
    // Should be 2026-05-24T09:00:00Z (9am UTC same day).
    expect(new Date(next).toISOString()).toBe('2026-05-24T09:00:00.000Z');
  });

  it('honors the tz argument (cron evaluates in the schedule’s tz)', () => {
    // Same cron `0 9 * * *` but evaluated against PT. From 08:30 UTC
    // (= 01:30 PT), the next 9am PT firing is 09:00 PT = 16:00 UTC.
    const from = new Date('2026-05-24T08:30:00Z');
    const next = getNextRunTime('0 9 * * *', from, 'America/Los_Angeles');
    // PT in late May = UTC-7 (DST). 9am PT = 16:00 UTC.
    expect(new Date(next).toISOString()).toBe('2026-05-24T16:00:00.000Z');
  });
});

describe('resolveScheduleTz', () => {
  it('returns UTC for mode=utc regardless of tz', () => {
    expect(resolveScheduleTz('utc')).toBe('UTC');
    expect(resolveScheduleTz('utc', 'America/Los_Angeles')).toBe('UTC');
  });

  it('returns the tz for mode=local with a valid tz', () => {
    expect(resolveScheduleTz('local', 'Asia/Tokyo')).toBe('Asia/Tokyo');
  });

  it('falls back to UTC when local is requested but no tz is supplied', () => {
    expect(resolveScheduleTz('local', undefined)).toBe('UTC');
    expect(resolveScheduleTz('local', null)).toBe('UTC');
  });

  it('returns UTC for unrecognized modes (safe default)', () => {
    expect(resolveScheduleTz(undefined)).toBe('UTC');
    expect(resolveScheduleTz('garbage')).toBe('UTC');
  });
});

describe('roundToMinute', () => {
  it('zeros seconds and milliseconds without touching the date', () => {
    const d = new Date('2026-05-24T08:30:32.789Z');
    expect(roundToMinute(d).toISOString()).toBe('2026-05-24T08:30:00.000Z');
  });
});
