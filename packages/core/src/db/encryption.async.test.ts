import { scrypt, scryptSync } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { decryptApiKeyAsync, encryptApiKey } from './encryption';

vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return { ...crypto, scrypt: vi.fn(crypto.scrypt), scryptSync: vi.fn(crypto.scryptSync) };
});

it('dispatches the legacy envelope KDF to native async scrypt', async () => {
  const envelope = encryptApiKey('synthetic', 'synthetic-master');
  vi.mocked(scrypt).mockClear();
  vi.mocked(scryptSync).mockClear();
  const opening = decryptApiKeyAsync(envelope, 'synthetic-master');
  expect(scrypt).toHaveBeenCalledTimes(1);
  expect(scryptSync).not.toHaveBeenCalled();
  await expect(opening).resolves.toBe('synthetic');
});
