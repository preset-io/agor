import { scrypt, scryptSync } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { openBoundSecretAsync, sealBoundSecret } from './oauth-secret-envelope';

vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return { ...crypto, scrypt: vi.fn(crypto.scrypt), scryptSync: vi.fn(crypto.scryptSync) };
});

it('uses callback-based scrypt rather than disguising synchronous KDF work in a promise', async () => {
  const envelope = sealBoundSecret('synthetic', 'synthetic-master', 'access-token', 'binding');
  vi.mocked(scrypt).mockClear();
  vi.mocked(scryptSync).mockClear();
  const opening = openBoundSecretAsync(envelope, 'synthetic-master', 'access-token', 'binding');
  expect(scrypt).toHaveBeenCalledTimes(1);
  expect(scryptSync).not.toHaveBeenCalled();
  await expect(opening).resolves.toBe('synthetic');
});
