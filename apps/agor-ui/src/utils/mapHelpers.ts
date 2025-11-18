/**
 * Helper utilities for working with Map-based data stores
 */

/**
 * Convert a Map to an array of values
 * Useful for rendering lists from Map-based stores
 */
export function mapToArray<T>(map: Map<string, T>): T[] {
  return Array.from(map.values());
}

/**
 * Convert a Map to a sorted array of values
 * @param map - The map to convert
 * @param compareFn - Optional compare function for sorting
 */
export function mapToSortedArray<T>(map: Map<string, T>, compareFn?: (a: T, b: T) => number): T[] {
  const array = Array.from(map.values());
  return compareFn ? array.sort(compareFn) : array;
}

/**
 * Filter a Map and return an array of matching values
 * @param map - The map to filter
 * @param predicate - Filter predicate
 */
export function filterMap<T>(map: Map<string, T>, predicate: (value: T) => boolean): T[] {
  return Array.from(map.values()).filter(predicate);
}

/**
 * Find a value in a Map using a predicate
 * @param map - The map to search
 * @param predicate - Search predicate
 */
export function findInMap<T>(map: Map<string, T>, predicate: (value: T) => boolean): T | undefined {
  for (const value of map.values()) {
    if (predicate(value)) {
      return value;
    }
  }
  return undefined;
}
