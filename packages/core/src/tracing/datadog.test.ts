import { describe, expect, it } from 'vitest';
import { type DatadogTracer, resolveDatadogTracer, setSpanTag, traceBestEffort } from './datadog';

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

describe('best-effort tracing', () => {
  it('forwards explicit resource and measurement without changing the operation or tags', () => {
    const tags = { 'span.kind': 'server' };
    const calls: { name: string; options: Parameters<DatadogTracer['trace']>[1] }[] = [];
    const tracer: DatadogTracer = {
      trace(name, options, work) {
        calls.push({ name, options });
        return work();
      },
    };
    expect(
      traceBestEffort(tracer, 'mcp.tool', tags, () => 42, {
        resource: 'agor_test',
        measured: true,
      })
    ).toBe(42);
    expect(calls).toEqual([
      {
        name: 'mcp.tool',
        options: { resource: 'agor_test', measured: true, tags },
      },
    ]);
  });

  it('runs work once when disabled or tracing throws before/after invocation', async () => {
    const tracers: (DatadogTracer | null)[] = [
      null,
      {
        trace() {
          throw new Error('tracer failed');
        },
      },
      {
        trace(_name, _options, fn) {
          fn();
          throw new Error('tracer failed');
        },
      },
    ];
    for (const tracer of tracers) {
      let runs = 0;
      await expect(
        traceBestEffort(tracer, 'test', {}, async () => {
          runs++;
          return 42;
        })
      ).resolves.toBe(42);
      expect(runs).toBe(1);
    }
  });

  it('preserves sync and async work errors, and ignores tag failures', async () => {
    const failure = new Error('work failed');
    const tracer: DatadogTracer = {
      trace(_name, _options, fn) {
        return fn();
      },
    };
    expect(() =>
      traceBestEffort(tracer, 'test', {}, () => {
        throw failure;
      })
    ).toThrow(failure);
    await expect(
      traceBestEffort(tracer, 'test', {}, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(() =>
      setSpanTag(
        {
          setTag() {
            throw new Error('tag failed');
          },
        },
        'test',
        1
      )
    ).not.toThrow();
  });
});
