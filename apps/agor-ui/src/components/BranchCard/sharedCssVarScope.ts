import type { ThemeConfig } from 'antd';

/**
 * Shared antd cssVar scopes for nested themes rendered many times (one per board card).
 *
 * antd 6 gives every nested `ConfigProvider` theme its own `useId` cssVar scope, so N cards
 * inject N copies of the token and component CSS variables. A fixed `cssVar.key` lets
 * cards share one scope, but cssinjs writes one `<style>` per key: two parents whose
 * nested themes compute different values must never get the same key.
 *
 * The parent's computed-token hash (`_tokenKey`) is not enough on its own. A nested
 * theme recomputes tokens from the parent's *recipe* (algorithms, seed tokens, component
 * config) with its own overrides, and two recipes can agree on the parent's tokens yet
 * diverge under the override. So the key also carries an id for the parent's merged
 * theme config, in which every function (global and component algorithms) is identified
 * by reference. Identical recipes share; any difference gets a new scope.
 */

// biome-ignore lint/complexity/noBannedTypes: algorithms are identified by reference only.
const functionIds = new WeakMap<Function, number>();
let nextFunctionId = 0;
const recipeIds = new Map<string, number>();
/** Theme configs from ConfigContext are memoized per provider, so cache by identity. */
const configRecipeIds = new WeakMap<object, number | null>();

const isPlainObject = (value: object): value is Record<string, unknown> => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** Stable text for a theme config value, or undefined when it can't be identified safely. */
function serializeRecipe(value: unknown, depth: number): string | undefined {
  if (value === undefined) return 'u';
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return Number.isNaN(value) ? 'NaN' : String(value);
  if (typeof value === 'function') {
    let id = functionIds.get(value);
    if (id === undefined) {
      id = ++nextFunctionId;
      functionIds.set(value, id);
    }
    return `f${id}`;
  }
  if (typeof value !== 'object' || depth > 8) return undefined;
  if (Array.isArray(value)) {
    const items = value.map((item) => serializeRecipe(item, depth + 1));
    return items.includes(undefined) ? undefined : `[${items.join(',')}]`;
  }
  if (!isPlainObject(value)) return undefined;
  const entries: string[] = [];
  for (const key of Object.keys(value).sort()) {
    // The parent's own scope key never changes a computed value.
    if (depth === 0 && key === 'cssVar') {
      const prefix = (value.cssVar as ThemeConfig['cssVar'] & { prefix?: string })?.prefix;
      entries.push(`cssVar:${JSON.stringify(prefix ?? null)}`);
      continue;
    }
    const serialized = serializeRecipe(value[key], depth + 1);
    if (serialized === undefined) return undefined;
    entries.push(`${JSON.stringify(key)}:${serialized}`);
  }
  return `{${entries.join(',')}}`;
}

/** Interned id for a parent theme recipe, or null when the recipe can't be identified. */
function themeRecipeId(config: ThemeConfig | undefined): number | null {
  if (config === undefined) return 0;
  const cached = configRecipeIds.get(config);
  if (cached !== undefined) return cached;
  const recipe = serializeRecipe(config, 0);
  let id: number | null = null;
  if (recipe !== undefined) {
    id = recipeIds.get(recipe) ?? recipeIds.size + 1;
    recipeIds.set(recipe, id);
  }
  configRecipeIds.set(config, id);
  return id;
}

/**
 * Scope identity for nested themes under one parent: its computed-token hash plus its
 * recipe id. Undefined (antd falls back to a per-instance scope) when either is unknown.
 */
export function parentCssVarScopeId(
  parentTokenKey: string | undefined,
  parentConfig: ThemeConfig | undefined
): string | undefined {
  if (!parentTokenKey) return undefined;
  const recipeId = themeRecipeId(parentConfig);
  return recipeId === null ? undefined : `${parentTokenKey}-r${recipeId}`;
}

/** A cssVar scope shared by every nested theme `name` under the same parent scope id. */
export const sharedCssVarScope = (name: string, parentScopeId: string | undefined) =>
  parentScopeId ? { cssVar: { key: `agor-${name}-${parentScopeId}` } } : undefined;
