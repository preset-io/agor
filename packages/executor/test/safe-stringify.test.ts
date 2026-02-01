/**
 * Unit tests for safeStringify utility
 * Tests circular reference handling and edge cases for Gemini tool response serialization
 */

import { describe, expect, it } from 'vitest';

/**
 * Safely stringify an object, handling circular references and edge cases
 * Uses a WeakSet to track seen objects and replaces circular refs with a descriptive string
 *
 * @example
 * // Circular reference handling
 * const obj = { a: 1 };
 * obj.self = obj;
 * safeStringify(obj); // '{"a":1,"self":"[Circular Reference]"}'
 *
 * @example
 * // BigInt serialization
 * safeStringify({ count: 123n }); // '{"count":"123"}'
 *
 * @param obj - Any value to stringify (typically an object)
 * @returns JSON string with circular references replaced by "[Circular Reference]"
 */
function safeStringify(obj: unknown): string {
  const seen = new WeakSet();

  return JSON.stringify(obj, (key, value) => {
    // Handle BigInt serialization (would throw TypeError otherwise)
    if (typeof value === 'bigint') {
      return value.toString();
    }

    // Handle non-object values normally
    if (typeof value !== 'object' || value === null) {
      return value;
    }

    // Detect circular references
    if (seen.has(value)) {
      return '[Circular Reference]';
    }

    seen.add(value);
    return value;
  });
}

describe('safeStringify', () => {
  describe('normal serialization', () => {
    it('should handle simple objects', () => {
      const obj = { a: 1, b: 'test', c: true };
      const result = safeStringify(obj);
      expect(result).toBe('{"a":1,"b":"test","c":true}');
      expect(JSON.parse(result)).toEqual(obj);
    });

    it('should handle arrays', () => {
      const arr = [1, 2, 3, 'test', { nested: true }];
      const result = safeStringify(arr);
      expect(JSON.parse(result)).toEqual(arr);
    });

    it('should handle null', () => {
      const result = safeStringify(null);
      expect(result).toBe('null');
    });

    it('should handle undefined', () => {
      const result = safeStringify(undefined);
      expect(result).toBe(undefined);
    });

    it('should handle nested objects', () => {
      const obj = {
        level1: {
          level2: {
            level3: {
              value: 'deep',
            },
          },
        },
      };
      const result = safeStringify(obj);
      expect(JSON.parse(result)).toEqual(obj);
    });
  });

  describe('circular reference handling', () => {
    it('should handle simple circular reference', () => {
      const obj: any = { a: 1 };
      obj.self = obj;
      const result = safeStringify(obj);
      expect(result).toBe('{"a":1,"self":"[Circular Reference]"}');
      const parsed = JSON.parse(result);
      expect(parsed.a).toBe(1);
      expect(parsed.self).toBe('[Circular Reference]');
    });

    it('should handle nested circular reference', () => {
      const parent: any = { name: 'parent' };
      const child: any = { name: 'child', parent };
      parent.child = child;
      const result = safeStringify(parent);
      const parsed = JSON.parse(result);
      expect(parsed.name).toBe('parent');
      expect(parsed.child.name).toBe('child');
      expect(parsed.child.parent).toBe('[Circular Reference]');
    });

    it('should handle circular reference in arrays', () => {
      const arr: any[] = [1, 2, 3];
      arr.push(arr);
      const result = safeStringify(arr);
      expect(result).toBe('[1,2,3,"[Circular Reference]"]');
      const parsed = JSON.parse(result);
      expect(parsed[0]).toBe(1);
      expect(parsed[3]).toBe('[Circular Reference]');
    });

    it('should handle multiple circular references', () => {
      const obj1: any = { name: 'obj1' };
      const obj2: any = { name: 'obj2' };
      obj1.ref = obj2;
      obj2.ref = obj1;
      const result = safeStringify(obj1);
      const parsed = JSON.parse(result);
      expect(parsed.name).toBe('obj1');
      expect(parsed.ref.name).toBe('obj2');
      expect(parsed.ref.ref).toBe('[Circular Reference]');
    });
  });

  describe('edge case handling', () => {
    it('should handle BigInt values', () => {
      const obj = { count: 123n, value: 456n };
      const result = safeStringify(obj);
      expect(result).toBe('{"count":"123","value":"456"}');
      const parsed = JSON.parse(result);
      expect(parsed.count).toBe('123');
      expect(parsed.value).toBe('456');
    });

    it('should handle mixed BigInt and regular numbers', () => {
      const obj = { regular: 42, big: 9007199254740991n };
      const result = safeStringify(obj);
      const parsed = JSON.parse(result);
      expect(parsed.regular).toBe(42);
      expect(parsed.big).toBe('9007199254740991');
    });

    it('should handle objects with undefined values', () => {
      const obj = { a: 1, b: undefined, c: 'test' };
      const result = safeStringify(obj);
      // JSON.stringify omits undefined values in objects
      expect(result).toBe('{"a":1,"c":"test"}');
    });

    it('should handle arrays with undefined values', () => {
      const arr = [1, undefined, 3];
      const result = safeStringify(arr);
      // JSON.stringify converts undefined to null in arrays
      expect(result).toBe('[1,null,3]');
    });

    it('should handle Date objects', () => {
      const obj = { timestamp: new Date('2024-01-01T00:00:00Z') };
      const result = safeStringify(obj);
      const parsed = JSON.parse(result);
      expect(parsed.timestamp).toBe('2024-01-01T00:00:00.000Z');
    });

    it('should handle empty objects and arrays', () => {
      expect(safeStringify({})).toBe('{}');
      expect(safeStringify([])).toBe('[]');
    });

    it('should handle objects with functions (omitted)', () => {
      const obj = { a: 1, fn: () => {}, b: 2 };
      const result = safeStringify(obj);
      expect(result).toBe('{"a":1,"b":2}');
    });

    it('should handle objects with symbols (omitted)', () => {
      const sym = Symbol('test');
      const obj = { a: 1, [sym]: 'symbol value', b: 2 };
      const result = safeStringify(obj);
      expect(result).toBe('{"a":1,"b":2}');
    });
  });

  describe('Gemini tool response scenarios', () => {
    it('should handle file system tool response with circular refs', () => {
      // Simulate a fs.Stats-like object that might have circular refs
      const fileStats: any = {
        size: 1024,
        isFile: true,
        path: '/test/file.txt',
      };
      fileStats.parent = fileStats; // Circular reference
      const result = safeStringify(fileStats);
      const parsed = JSON.parse(result);
      expect(parsed.size).toBe(1024);
      expect(parsed.parent).toBe('[Circular Reference]');
    });

    it('should handle tool error responses', () => {
      const errorResponse = {
        error: 'File not found',
        code: 'ENOENT',
        path: '/missing/file.txt',
      };
      const result = safeStringify(errorResponse);
      expect(JSON.parse(result)).toEqual(errorResponse);
    });

    it('should handle complex nested tool responses', () => {
      const toolResponse = {
        status: 'success',
        data: {
          files: [
            { name: 'file1.txt', size: 100 },
            { name: 'file2.txt', size: 200 },
          ],
          metadata: {
            totalCount: 2,
            timestamp: new Date('2024-01-01'),
          },
        },
      };
      const result = safeStringify(toolResponse);
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      expect(parsed.data.files).toHaveLength(2);
    });
  });
});
