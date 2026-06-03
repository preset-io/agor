import { describe, expect, it } from 'vitest';
import { hasExplicitEntityRouteTarget } from './routeTargets';

describe('hasExplicitEntityRouteTarget', () => {
  it.each([
    [{ sessionShortId: 'session' }, true],
    [{ branchShortId: 'branch' }, true],
    [{ artifactShortId: 'artifact' }, true],
    [{}, false],
  ])('returns the expected value for params %j', (params, expected) => {
    expect(hasExplicitEntityRouteTarget(params)).toBe(expected);
  });
});
