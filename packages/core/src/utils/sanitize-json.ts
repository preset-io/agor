const REPLACEMENT_CHARACTER = '\uFFFD';

export const JSON_SANITIZER_LIMITS = {
  maxDepth: 100,
  /** Containers plus array slots and object properties visited. */
  maxNodes: 100_000,
  /** UTF-16 code units across every string value and object key. */
  maxStringCodeUnits: 16 * 1024 * 1024,
} as const;

export class JsonSanitizationError extends Error {
  constructor(
    public readonly category: 'cycle' | 'depth' | 'size' | 'unsupported' | 'key_collision'
  ) {
    super(`JSON value cannot be sanitized: ${category}`);
    this.name = 'JsonSanitizationError';
  }
}

export function sanitizeUnicodeString(value: string): string {
  let output: string | undefined;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 0) {
      output ??= value.slice(0, index);
      output += REPLACEMENT_CHARACTER;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        if (output !== undefined) output += value[index] + value[index + 1];
        index++;
      } else {
        output ??= value.slice(0, index);
        output += REPLACEMENT_CHARACTER;
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      output ??= value.slice(0, index);
      output += REPLACEMENT_CHARACTER;
    } else if (output !== undefined) output += value[index];
  }
  return output ?? value;
}

type JsonContainer = Record<string, unknown> | unknown[];
type EnterFrame = { kind: 'enter'; source: object; target: JsonContainer; depth: number };
type ExitFrame = { kind: 'exit'; source: object };

function boundedEnumerableKeys(source: object, remaining: number): string[] {
  if (Array.isArray(source)) {
    if (source.length > remaining) throw new JsonSanitizationError('size');
    return Object.keys(source);
  }
  const keys: string[] = [];
  for (const key in source) {
    if (!Object.hasOwn(source, key)) continue;
    if (keys.length >= remaining) throw new JsonSanitizationError('size');
    keys.push(key);
  }
  return keys;
}

function defineJsonProperty(target: JsonContainer, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * Clone and normalize a JSON-compatible value for persistence without recursive
 * call-stack growth. Work is capped before enumerating/copying large flat
 * containers. Object keys are normalized too; a normalization collision is
 * rejected rather than silently overwriting data.
 */
export function sanitizeJsonValue<T>(input: T): T {
  let workUnits = 0;
  let stringCodeUnits = 0;
  const countString = (value: string): string => {
    stringCodeUnits += value.length;
    if (stringCodeUnits > JSON_SANITIZER_LIMITS.maxStringCodeUnits)
      throw new JsonSanitizationError('size');
    return sanitizeUnicodeString(value);
  };

  if (typeof input === 'string') return countString(input) as T;
  if (input === null || typeof input === 'boolean' || typeof input === 'number') {
    if (typeof input === 'number' && !Number.isFinite(input))
      throw new JsonSanitizationError('unsupported');
    return input;
  }
  if (typeof input !== 'object') throw new JsonSanitizationError('unsupported');

  const root: JsonContainer = Array.isArray(input) ? [] : {};
  const stack: Array<EnterFrame | ExitFrame> = [
    { kind: 'enter', source: input, target: root, depth: 0 },
  ];
  const activePath = new WeakSet<object>();

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === 'exit') {
      activePath.delete(frame.source);
      continue;
    }
    if (activePath.has(frame.source)) throw new JsonSanitizationError('cycle');
    if (frame.depth > JSON_SANITIZER_LIMITS.maxDepth) throw new JsonSanitizationError('depth');
    const proto = Object.getPrototypeOf(frame.source);
    if (!Array.isArray(frame.source) && proto !== Object.prototype && proto !== null)
      throw new JsonSanitizationError('unsupported');

    const remaining = JSON_SANITIZER_LIMITS.maxNodes - workUnits - 1;
    if (remaining < 0) throw new JsonSanitizationError('size');
    const keys = boundedEnumerableKeys(frame.source, remaining);
    const entryCount = Array.isArray(frame.source) ? frame.source.length : keys.length;
    workUnits += 1 + entryCount;
    if (workUnits > JSON_SANITIZER_LIMITS.maxNodes) throw new JsonSanitizationError('size');

    activePath.add(frame.source);
    stack.push({ kind: 'exit', source: frame.source });
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index];
      const value = (frame.source as Record<string, unknown>)[key];
      const targetKey = Array.isArray(frame.target) ? key : countString(key);
      if (!Array.isArray(frame.target) && Object.hasOwn(frame.target, targetKey))
        throw new JsonSanitizationError('key_collision');

      let sanitized: unknown;
      if (value === undefined) {
        if (Array.isArray(frame.target)) defineJsonProperty(frame.target, targetKey, null);
        continue;
      }
      if (typeof value === 'string') sanitized = countString(value);
      else if (value === null || typeof value === 'boolean' || typeof value === 'number') {
        if (typeof value === 'number' && !Number.isFinite(value))
          throw new JsonSanitizationError('unsupported');
        sanitized = value;
      } else if (typeof value === 'object') {
        const child: JsonContainer = Array.isArray(value) ? [] : {};
        sanitized = child;
        stack.push({ kind: 'enter', source: value, target: child, depth: frame.depth + 1 });
      } else throw new JsonSanitizationError('unsupported');
      defineJsonProperty(frame.target, targetKey, sanitized);
    }
  }
  return root as T;
}
