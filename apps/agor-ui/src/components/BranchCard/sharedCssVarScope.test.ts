import { type MappingAlgorithm, type ThemeConfig, theme } from 'antd';
import { describe, expect, it } from 'vitest';
import { RECIPE_ID_CACHE_LIMIT, recipeIdCacheSize, themeRecipeId } from './sharedCssVarScope';

/** A fresh algorithm identity that computes the same tokens as the default one. */
const freshAlgorithm = (): MappingAlgorithm => (seed) => theme.defaultAlgorithm(seed);

describe('themeRecipeId', () => {
  it('shares an id for equal recipes and separates different algorithms', () => {
    const algorithm = freshAlgorithm();
    const a = themeRecipeId({ algorithm, token: { borderRadius: 8 } });
    expect(a).not.toBeNull();
    expect(themeRecipeId({ token: { borderRadius: 8 }, algorithm })).toBe(a);
    expect(themeRecipeId({ algorithm: freshAlgorithm(), token: { borderRadius: 8 } })).not.toBe(a);
    expect(
      themeRecipeId({ components: { Tree: { algorithm: freshAlgorithm() } } } as ThemeConfig)
    ).not.toBe(a);
  });

  it('stays bounded under fresh algorithm identities and never reuses an id', () => {
    const count = RECIPE_ID_CACHE_LIMIT * 16;
    const ids = Array.from({ length: count }, () => themeRecipeId({ algorithm: freshAlgorithm() }));
    expect(ids).not.toContain(null);
    expect(new Set(ids).size).toBe(count);
    expect(recipeIdCacheSize()).toBeLessThanOrEqual(RECIPE_ID_CACHE_LIMIT);
  });

  it('gives an evicted recipe a new id instead of another recipe’s', () => {
    const algorithm = freshAlgorithm();
    const first = themeRecipeId({ algorithm });
    // A fresh config object bypasses the per-config cache; the recipe is still interned.
    expect(themeRecipeId({ algorithm })).toBe(first);
    const seen = new Set([first]);
    for (let i = 0; i < RECIPE_ID_CACHE_LIMIT; i++) {
      seen.add(themeRecipeId({ algorithm: freshAlgorithm() }));
    }
    const again = themeRecipeId({ algorithm });
    expect(seen.has(again)).toBe(false);
  });

  it('returns null for recipes it cannot identify', () => {
    expect(themeRecipeId({ token: { colorPrimary: new Date() as never } })).toBeNull();
  });
});
