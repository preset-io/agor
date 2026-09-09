import type { UUID } from '../types/id';
import { uuidV7FromRandomBytes } from './uuid-v7';

/**
 * Generate Agor's canonical UUIDv7 in a browser, including HTTP origins where
 * `crypto.randomUUID()` is intentionally unavailable. `getRandomValues()` is
 * the Web Crypto primitive browsers expose for cryptographic entropy there.
 */
export function generateId(): UUID {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) {
    throw new Error('Secure random number generation is unavailable in this browser');
  }
  return uuidV7FromRandomBytes(cryptoApi.getRandomValues(new Uint8Array(16)));
}
