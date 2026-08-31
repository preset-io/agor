import { afterEach, describe, expect, it } from 'vitest';
import { decryptApiKey, encryptApiKey, isEncrypted } from './encryption';

const KEY_A = 'encryption-test-master-key-a';
const KEY_B = 'encryption-test-master-key-b';

describe('legacy deployment-secret envelope', () => {
  const originalMasterSecret = process.env.AGOR_MASTER_SECRET;

  afterEach(() => {
    if (originalMasterSecret === undefined) delete process.env.AGOR_MASTER_SECRET;
    else process.env.AGOR_MASTER_SECRET = originalMasterSecret;
  });

  it('round-trips without embedding plaintext and randomizes each envelope', () => {
    const value = 'audit-canary-value';
    const first = encryptApiKey(value, KEY_A);
    const second = encryptApiKey(value, KEY_A);

    expect(first).not.toContain(value);
    expect(second).not.toContain(value);
    expect(first).not.toBe(second);
    expect(isEncrypted(first)).toBe(true);
    expect(decryptApiKey(first, KEY_A)).toBe(value);
    expect(decryptApiKey(second, KEY_A)).toBe(value);
  });

  it('round-trips an empty plaintext for credential classes that permit one', () => {
    const envelope = encryptApiKey('', KEY_A);

    expect(isEncrypted(envelope)).toBe(true);
    expect(decryptApiKey(envelope, KEY_A)).toBe('');
  });

  it('fails closed when the deployment master secret is unavailable', () => {
    delete process.env.AGOR_MASTER_SECRET;

    expect(() => encryptApiKey('canary')).toThrow('Secret encryption requires AGOR_MASTER_SECRET');
    expect(() => decryptApiKey('not-an-envelope')).toThrow(
      'Secret decryption requires AGOR_MASTER_SECRET'
    );
  });

  it('rejects an explicitly empty deployment secret', () => {
    expect(() => encryptApiKey('canary', '')).toThrow(
      'Secret encryption requires AGOR_MASTER_SECRET'
    );
    expect(() => decryptApiKey(encryptApiKey('canary', KEY_A), '')).toThrow(
      'Secret decryption requires AGOR_MASTER_SECRET'
    );
  });

  it('normalizes wrong-key, tamper, and malformed-envelope failures', () => {
    const envelope = encryptApiKey('canary', KEY_A);
    const [salt, iv, tag, ciphertext] = envelope.split(':');
    const malformed = [
      'plaintext',
      `${salt.slice(2)}:${iv}:${tag}:${ciphertext}`,
      `${salt}:${iv}zz:${tag}:${ciphertext}`,
      `${salt}:${iv}:${tag.slice(2)}:${ciphertext}`,
      `${salt}:${iv}:${tag}:${ciphertext}f`,
      `${salt}:${iv}:${tag}:${ciphertext}:extra`,
    ];

    expect(() => decryptApiKey(envelope, KEY_B)).toThrow('Secret decryption failed');
    for (const candidate of malformed) {
      expect(() => decryptApiKey(candidate, KEY_A)).toThrow('Secret decryption failed');
      expect(isEncrypted(candidate)).toBe(false);
    }

    const last = ciphertext.at(-1) === '0' ? '1' : '0';
    const tampered = `${salt}:${iv}:${tag}:${ciphertext.slice(0, -1)}${last}`;
    expect(() => decryptApiKey(tampered, KEY_A)).toThrow('Secret decryption failed');
  });
});
