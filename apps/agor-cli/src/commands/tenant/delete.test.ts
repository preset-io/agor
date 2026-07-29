import { describe, expect, it } from 'vitest';
import { tenantDeleteErrorMessage } from './delete';

describe('tenantDeleteErrorMessage', () => {
  it('redacts credentials from Error messages', () => {
    expect(
      tenantDeleteErrorMessage(
        new Error('connect postgresql://operator:top-secret@db.example.test/agor failed')
      )
    ).toBe('connect postgresql://[redacted]@db.example.test/agor failed');
  });

  it('stringifies non-Error failures before redacting credentials', () => {
    expect(
      tenantDeleteErrorMessage(
        'connect postgresql://operator:top-secret@db.example.test/agor failed'
      )
    ).toBe('connect postgresql://[redacted]@db.example.test/agor failed');
  });
});
