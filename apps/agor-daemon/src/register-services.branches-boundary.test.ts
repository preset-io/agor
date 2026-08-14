import { describe, expect, it } from 'vitest';
import { BRANCHES_SERVICE_TRANSPORT_METHODS } from './services/branches';

describe('branches transport boundary', () => {
  it('does not expose raw row creation or whole-row replacement', () => {
    expect(BRANCHES_SERVICE_TRANSPORT_METHODS).not.toContain('create');
    expect(BRANCHES_SERVICE_TRANSPORT_METHODS).not.toContain('update');
    expect(BRANCHES_SERVICE_TRANSPORT_METHODS).toContain('patch');
  });
});
