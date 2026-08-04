import { describe, expect, it } from 'vitest';
import { tenantDeleteErrorMarker } from './delete';

describe('tenantDeleteErrorMarker', () => {
  it('uses the shared machine-readable portability failure marker', () => {
    expect(JSON.parse(tenantDeleteErrorMarker(new Error('do not expose me')))).toEqual({
      marker: 'agor.tenant-portability.error',
      version: 1,
      category: 'unknown',
    });
  });
});
