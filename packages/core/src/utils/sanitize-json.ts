const REPLACEMENT_CHARACTER = '\uFFFD';

export const JSON_SANITIZER_LIMITS = {
  maxDepth: 100,
  maxNodes: 100_000,
  maxStringCodeUnits: 16 * 1024 * 1024,
} as const;

export class JsonSanitizationError extends Error {
  constructor(public readonly category: 'cycle' | 'depth' | 'size' | 'unsupported') {
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

/** Clone and sanitize a JSON-compatible value without recursive call-stack growth. */
export function sanitizeJsonValue<T>(input: T): T {
  if (typeof input === 'string') return sanitizeUnicodeString(input) as T;
  if (input === null || typeof input === 'boolean' || typeof input === 'number') {
    if (typeof input === 'number' && !Number.isFinite(input))
      throw new JsonSanitizationError('unsupported');
    return input;
  }
  if (typeof input !== 'object') throw new JsonSanitizationError('unsupported');

  const root: unknown = Array.isArray(input) ? [] : {};
  const stack: Array<{
    source: object;
    target: Record<string, unknown> | unknown[];
    depth: number;
  }> = [{ source: input, target: root as Record<string, unknown> | unknown[], depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let stringCodeUnits = 0;

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (seen.has(frame.source)) throw new JsonSanitizationError('cycle');
    seen.add(frame.source);
    if (frame.depth > JSON_SANITIZER_LIMITS.maxDepth) throw new JsonSanitizationError('depth');
    if (++nodes > JSON_SANITIZER_LIMITS.maxNodes) throw new JsonSanitizationError('size');
    const proto = Object.getPrototypeOf(frame.source);
    if (!Array.isArray(frame.source) && proto !== Object.prototype && proto !== null)
      throw new JsonSanitizationError('unsupported');

    for (const key of Object.keys(frame.source)) {
      const value = (frame.source as Record<string, unknown>)[key];
      let sanitized: unknown;
      if (value === undefined) {
        if (Array.isArray(frame.target)) frame.target[Number(key)] = null;
        continue;
      }
      if (typeof value === 'string') {
        stringCodeUnits += value.length;
        if (stringCodeUnits > JSON_SANITIZER_LIMITS.maxStringCodeUnits)
          throw new JsonSanitizationError('size');
        sanitized = sanitizeUnicodeString(value);
      } else if (value === null || typeof value === 'boolean' || typeof value === 'number') {
        if (typeof value === 'number' && !Number.isFinite(value))
          throw new JsonSanitizationError('unsupported');
        sanitized = value;
      } else if (typeof value === 'object') {
        const child: unknown = Array.isArray(value) ? [] : {};
        sanitized = child;
        stack.push({
          source: value,
          target: child as Record<string, unknown> | unknown[],
          depth: frame.depth + 1,
        });
      } else throw new JsonSanitizationError('unsupported');
      if (Array.isArray(frame.target)) frame.target[Number(key)] = sanitized;
      else frame.target[key] = sanitized;
    }
  }
  return root as T;
}
