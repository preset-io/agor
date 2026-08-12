import type { DeepReadonly } from '@agor/core/types';

/** Recursively freeze a plain configuration snapshot and return its deep-readonly view. */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

/** Clone plain configuration data before freezing so the caller retains ownership. */
export function deepFreezeClone<T>(value: T): DeepReadonly<T> {
  return deepFreeze(structuredClone(value));
}
