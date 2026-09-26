import { afterEach, describe, expect, it } from 'vitest';
import { decryptApiKey, decryptApiKeyAsync, encryptApiKey, isEncrypted } from './encryption';

const KEY_A = 'encryption-test-master-key-a';
const KEY_B = 'encryption-test-master-key-b';

describe.each([
  ['sync', async (value: string, key?: string) => decryptApiKey(value, key)],
  ['async', decryptApiKeyAsync],
] as const)('legacy deployment-secret envelope (%s)', (_mode, decrypt) => {
  const originalMasterSecret = process.env.AGOR_MASTER_SECRET;

  afterEach(() => {
    if (originalMasterSecret === undefined) delete process.env.AGOR_MASTER_SECRET;
    else process.env.AGOR_MASTER_SECRET = originalMasterSecret;
  });

  it('round-trips without embedding plaintext and randomizes each envelope', async () => {
    const value = 'audit-canary-value';
    const first = encryptApiKey(value, KEY_A);
    const second = encryptApiKey(value, KEY_A);

    expect(first).not.toContain(value);
    expect(second).not.toContain(value);
    expect(first).not.toBe(second);
    expect(isEncrypted(first)).toBe(true);
    await expect(decrypt(first, KEY_A)).resolves.toBe(value);
    await expect(decrypt(second, KEY_A)).resolves.toBe(value);
  });

  it('round-trips an empty plaintext for credential classes that permit one', async () => {
    const envelope = encryptApiKey('', KEY_A);

    expect(isEncrypted(envelope)).toBe(true);
    await expect(decrypt(envelope, KEY_A)).resolves.toBe('');
  });

  it('fails closed when the deployment master secret is unavailable', async () => {
    delete process.env.AGOR_MASTER_SECRET;

    expect(() => encryptApiKey('canary')).toThrow('Secret encryption requires AGOR_MASTER_SECRET');
    await expect(decrypt('not-an-envelope')).rejects.toThrow(
      'Secret decryption requires AGOR_MASTER_SECRET'
    );
  });

  it('rejects an explicitly empty deployment secret', async () => {
    expect(() => encryptApiKey('canary', '')).toThrow(
      'Secret encryption requires AGOR_MASTER_SECRET'
    );
    await expect(decrypt(encryptApiKey('canary', KEY_A), '')).rejects.toThrow(
      'Secret decryption requires AGOR_MASTER_SECRET'
    );
  });

  it('normalizes wrong-key, tamper, and malformed-envelope failures', async () => {
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

    await expect(decrypt(envelope, KEY_B)).rejects.toThrow('Secret decryption failed');
    for (const candidate of malformed) {
      await expect(decrypt(candidate, KEY_A)).rejects.toThrow('Secret decryption failed');
      expect(isEncrypted(candidate)).toBe(false);
    }

    const last = ciphertext.at(-1) === '0' ? '1' : '0';
    const tampered = `${salt}:${iv}:${tag}:${ciphertext.slice(0, -1)}${last}`;
    await expect(decrypt(tampered, KEY_A)).rejects.toThrow('Secret decryption failed');
  });
});
