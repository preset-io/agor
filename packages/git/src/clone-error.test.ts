import { describe, expect, it } from 'vitest';
import { categorizeGitError } from './index.js';

describe('categorizeGitError', () => {
  it('distinguishes clone lifecycle timeouts from remote network timeouts', () => {
    expect(categorizeGitError('Clone timed out after 30 minutes.')).toBe('timeout');
    expect(categorizeGitError('GitPluginError: block timeout reached')).toBe('timeout');
    expect(categorizeGitError('fatal: operation timed out')).toBe('network');
  });
});
