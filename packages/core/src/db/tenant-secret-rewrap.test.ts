import { describe, expect, it } from 'vitest';
import { decryptApiKey, ENCRYPTED_ENVELOPE_PATTERN, encryptApiKey } from './encryption';
import {
  countSourceOnlyEnvelopes,
  emptySecretRewrapCounts,
  rewrapEnvelopesInText,
} from './tenant-secret-rewrap';

const keys = { fromKey: 'source-key', toKey: 'transfer-key' };

describe('rewrapEnvelopesInText', () => {
  it('reseals only envelopes the source key opens and keeps every other byte', () => {
    const sealed = encryptApiKey('xoxb-secret', keys.fromKey);
    const foreign = encryptApiKey('other', 'someone-elses-key');
    const line = JSON.stringify({ a: sealed, nested: { b: foreign }, sha: 'deadbeef'.repeat(8) });
    const counts = emptySecretRewrapCounts();
    const out = rewrapEnvelopesInText(line, keys, counts);
    const parsed = JSON.parse(out) as { a: string; nested: { b: string }; sha: string };
    expect(decryptApiKey(parsed.a, keys.toKey)).toBe('xoxb-secret');
    expect(parsed.nested.b).toBe(foreign);
    expect(parsed.sha).toBe('deadbeef'.repeat(8));
    expect(counts).toEqual({
      scannedValues: 2,
      rewrappedValues: 1,
      alreadyDestinationKey: 0,
      unreadableValues: 1,
    });
    expect(countSourceOnlyEnvelopes(out, keys)).toBe(0);
    // A second pass converges instead of double-encrypting.
    const again = emptySecretRewrapCounts();
    expect(rewrapEnvelopesInText(out, keys, again)).toBe(out);
    expect(again.alreadyDestinationKey).toBe(1);
  });

  it('counts envelopes a wrong source key cannot open instead of passing them silently', () => {
    const sealed = encryptApiKey('xoxb-secret', keys.fromKey);
    const counts = emptySecretRewrapCounts();
    const wrong = { fromKey: 'not-the-source-key', toKey: keys.toKey };
    expect(rewrapEnvelopesInText(sealed, wrong, counts)).toBe(sealed);
    expect(counts.rewrappedValues).toBe(0);
    expect(counts.unreadableValues).toBe(1);
    // The residual proof alone cannot see it: the wrong key opens nothing.
    expect(countSourceOnlyEnvelopes(sealed, wrong)).toBe(0);
  });
});

describe('ENCRYPTED_ENVELOPE_PATTERN', () => {
  it('matches the envelopes decryption accepts and nothing run together with them', () => {
    const sealed = encryptApiKey('xoxb-secret', keys.fromKey);
    expect(ENCRYPTED_ENVELOPE_PATTERN.test(`token=${sealed};`)).toBe(true);
    expect(ENCRYPTED_ENVELOPE_PATTERN.test(sealed.toUpperCase())).toBe(true);
    expect(ENCRYPTED_ENVELOPE_PATTERN.test(encryptApiKey('', keys.fromKey))).toBe(true);
    expect(ENCRYPTED_ENVELOPE_PATTERN.test(`${sealed}a`)).toBe(false);
    expect(ENCRYPTED_ENVELOPE_PATTERN.test(`ab${sealed}`)).toBe(false);
    expect(ENCRYPTED_ENVELOPE_PATTERN.test(`${sealed}:00`)).toBe(false);
  });
});
