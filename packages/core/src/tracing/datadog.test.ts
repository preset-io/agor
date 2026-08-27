import { describe, expect, it } from 'vitest';
import { resolveDatadogTracer } from './datadog';

describe('resolveDatadogTracer', () => {
  const validTracer = { trace: () => undefined };
  const notFound = (id: string) => {
    throw Object.assign(new Error(`Cannot find module '${id}'`), { code: 'MODULE_NOT_FOUND' });
  };

  it('prefers dd-trace-api, then falls back to dd-trace', () => {
    const seen: string[] = [];
    expect(
      resolveDatadogTracer((id) => {
        seen.push(id);
        if (id === 'dd-trace-api') return validTracer;
        throw new Error('unreached');
      })
    ).toBe(validTracer);
    expect(seen).toEqual(['dd-trace-api']);

    expect(resolveDatadogTracer((id) => (id === 'dd-trace' ? validTracer : notFound(id)))).toBe(
      validTracer
    );
  });

  it('unwraps a default export and returns null when neither resolves', () => {
    expect(
      resolveDatadogTracer((id) =>
        id === 'dd-trace-api' ? { default: validTracer } : notFound(id)
      )
    ).toBe(validTracer);
    expect(resolveDatadogTracer(notFound)).toBeNull();
    expect(resolveDatadogTracer(() => ({}))).toBeNull(); // no callable .trace
  });
});
