import { describe, expect, it } from 'vitest';
import { resolveTracerModule } from './datadog.js';

describe('resolveTracerModule', () => {
  const validTracer = { trace: () => Promise.resolve() };
  const notFound = (id: string) => {
    throw Object.assign(new Error(`Cannot find module '${id}'`), { code: 'MODULE_NOT_FOUND' });
  };

  it('returns dd-trace-api when present, without consulting dd-trace', () => {
    const seen: string[] = [];
    const resolved = resolveTracerModule((id) => {
      seen.push(id);
      if (id === 'dd-trace-api') return validTracer;
      throw new Error('should not be reached');
    });
    expect(resolved).toBe(validTracer);
    expect(seen).toEqual(['dd-trace-api']);
  });

  it('falls back to dd-trace when dd-trace-api is absent', () => {
    const resolved = resolveTracerModule((id) => (id === 'dd-trace' ? validTracer : notFound(id)));
    expect(resolved).toBe(validTracer);
  });

  it('unwraps a default export', () => {
    const resolved = resolveTracerModule((id) =>
      id === 'dd-trace-api' ? { default: validTracer } : notFound(id)
    );
    expect(resolved).toBe(validTracer);
  });

  it('skips a module without a callable trace() and returns null when both absent', () => {
    expect(resolveTracerModule(() => ({}))).toBeNull();
    expect(resolveTracerModule(notFound)).toBeNull();
  });
});
