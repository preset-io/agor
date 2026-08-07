import { describe, expect, it } from 'vitest';
import { requiresToolSelection } from './install';

describe('requiresToolSelection', () => {
  it('errors when the user named nothing to do', () => {
    expect(requiresToolSelection({ toolCount: 0, prune: false, restore: false })).toBe(true);
  });

  it('accepts --prune on its own as housekeeping', () => {
    expect(requiresToolSelection({ toolCount: 0, prune: true, restore: false })).toBe(false);
  });

  // Regression: --restore that found nothing to restore must stay a no-op, or an
  // unattended upgrade script fails on a machine with no tools installed yet.
  it('accepts --restore that resolved to no tools', () => {
    expect(requiresToolSelection({ toolCount: 0, prune: false, restore: true })).toBe(false);
  });

  it('accepts any run that resolved to at least one tool', () => {
    expect(requiresToolSelection({ toolCount: 2, prune: false, restore: false })).toBe(false);
  });
});
