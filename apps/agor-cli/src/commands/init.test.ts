import { describe, expect, it } from 'vitest';
import { isFreshInitState } from './init.js';

describe('safe init state detection', () => {
  it('treats a pre-created empty .agor mount as fresh', () => {
    expect(
      isFreshInitState({
        baseExists: true,
        databaseExists: false,
        reposExist: false,
        branchesExist: false,
      })
    ).toBe(true);
  });

  it('does not treat existing data as fresh', () => {
    expect(
      isFreshInitState({
        baseExists: true,
        databaseExists: true,
        reposExist: true,
        branchesExist: true,
      })
    ).toBe(false);
  });
});
