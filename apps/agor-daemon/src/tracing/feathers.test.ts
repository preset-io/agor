import type { HookContext } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { createFeathersTracingHook, type DatadogTracer } from './feathers.js';

interface TracedCall {
  name: string;
  resource?: string;
  tags?: Record<string, unknown>;
}

/** Records trace() invocations and runs the wrapped fn, like dd-trace would. */
class RecordingTracer implements DatadogTracer {
  readonly calls: TracedCall[] = [];
  async trace<T>(
    name: string,
    options: { resource?: string; tags?: Record<string, unknown> },
    fn: () => Promise<T>
  ): Promise<T> {
    this.calls.push({ name, resource: options.resource, tags: options.tags });
    return fn();
  }
}

function ctx(path: string, method: string, provider?: string): HookContext {
  return { path, method, params: provider ? { provider } : {} } as unknown as HookContext;
}

describe('Feathers tracing hook', () => {
  it('is a passthrough when depth is off (never touches the tracer)', async () => {
    const tracer = new RecordingTracer();
    const hook = createFeathersTracingHook('off', { tracer });
    let ran = false;
    await hook(ctx('sessions', 'find', 'socketio'), async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(tracer.calls).toHaveLength(0);
  });

  it('is a passthrough when dd-trace is not loaded', async () => {
    const hook = createFeathersTracingHook('full', { tracer: null });
    let ran = false;
    await hook(ctx('sessions', 'find', 'socketio'), async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('names the span <service>.<method> and tags service/method/transport', async () => {
    const tracer = new RecordingTracer();
    const hook = createFeathersTracingHook('full', { tracer });
    await hook(ctx('sessions', 'find', 'socketio'), async () => undefined);
    expect(tracer.calls).toEqual([
      {
        name: 'feathers.request',
        resource: 'sessions.find',
        tags: {
          'feathers.service': 'sessions',
          'feathers.method': 'find',
          'feathers.transport': 'socketio',
          'span.kind': 'server',
        },
      },
    ]);
  });

  it('normalizes unknown methods to custom and internal (no-provider) transport', async () => {
    const tracer = new RecordingTracer();
    const hook = createFeathersTracingHook('full', { tracer });
    await hook(ctx('sessions', 'archive'), async () => undefined);
    expect(tracer.calls[0]?.resource).toBe('sessions.custom');
    expect(tracer.calls[0]?.tags?.['feathers.transport']).toBe('internal');
  });

  it('skips the high-frequency health probe at every depth', async () => {
    const tracer = new RecordingTracer();
    const hook = createFeathersTracingHook('full', { tracer });
    await hook(ctx('health', 'find', 'rest'), async () => undefined);
    expect(tracer.calls).toHaveLength(0);
  });

  it('full mode traces nested service-to-service calls as child spans', async () => {
    const tracer = new RecordingTracer();
    const hook = createFeathersTracingHook('full', { tracer });
    // Simulate branches.find fanning out to a nested sessions.get.
    await hook(ctx('branches', 'find', 'socketio'), async () => {
      await hook(ctx('sessions', 'get'), async () => undefined);
    });
    expect(tracer.calls.map((c) => c.resource)).toEqual(['branches.find', 'sessions.get']);
  });

  it('entrypoint mode suppresses nested fan-out to one span per request', async () => {
    const tracer = new RecordingTracer();
    const hook = createFeathersTracingHook('entrypoint', { tracer });
    await hook(ctx('branches', 'find', 'socketio'), async () => {
      // Nested internal calls inherit the request scope and are not traced.
      await hook(ctx('sessions', 'get'), async () => undefined);
      await hook(ctx('messages', 'find'), async () => undefined);
    });
    expect(tracer.calls.map((c) => c.resource)).toEqual(['branches.find']);
  });

  it('propagates errors while still opening the span', async () => {
    const tracer = new RecordingTracer();
    const hook = createFeathersTracingHook('full', { tracer });
    await expect(
      hook(ctx('sessions', 'find', 'socketio'), async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(tracer.calls).toHaveLength(1);
  });
});
