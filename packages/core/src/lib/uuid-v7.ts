import { v7 as uuidv7 } from 'uuid';
import type { UUID } from '../types/id';

/**
 * Canonical UUIDv7 method-3 encoding shared by Node and browser entrypoints.
 * Callers supply 16 cryptographically random bytes from their runtime.
 */
export function uuidV7FromRandomBytes(random: Uint8Array): UUID {
  if (random.byteLength !== 16) {
    throw new Error('UUIDv7 generation requires exactly 16 random bytes');
  }
  return uuidv7({ random }) as UUID;
}
