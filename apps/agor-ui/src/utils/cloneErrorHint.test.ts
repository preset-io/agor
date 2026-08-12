import { describe, expect, it } from 'vitest';
import { cloneErrorHint } from './cloneErrorHint';

describe('cloneErrorHint', () => {
  it('points private clones at the user environment settings', () => {
    expect(cloneErrorHint({ category: 'auth_failed' })).toContain('GITHUB_TOKEN');
  });

  it('explains how to repair certificate trust without weakening TLS', () => {
    const hint = cloneErrorHint({
      category: 'network',
      message: 'fatal: unable to get local issuer certificate',
    });
    expect(hint).toContain('CA trust store');
    expect(hint).toContain('do not disable SSL verification');
  });

  it('keeps ordinary network advice separate from TLS advice', () => {
    expect(cloneErrorHint({ category: 'network', message: 'Could not resolve host' })).toContain(
      'DNS'
    );
  });
});
