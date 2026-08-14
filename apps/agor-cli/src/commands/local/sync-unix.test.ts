import { describe, expect, it } from 'vitest';
import { canVerifyGlobalUnixState } from './sync-unix.js';

describe('canVerifyGlobalUnixState', () => {
  it('accepts a host-local SQLite file', () => {
    expect(canVerifyGlobalUnixState('file:/home/operator/.agor/agor.db')).toBe(true);
  });

  it.each([
    'postgresql://db.example/agor',
    'postgres://db.example/agor',
    'libsql://db.example/agor',
    'https://db.example/agor',
  ])('rejects a remote or tenant-scoped DB view: %s', (databaseUrl) => {
    expect(canVerifyGlobalUnixState(databaseUrl)).toBe(false);
  });
});
