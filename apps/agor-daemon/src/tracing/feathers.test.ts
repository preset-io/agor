import { feathers } from '@agor/core/feathers';
import type { HookContext } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { FEATHERS_INSTRUMENTATION_REASON } from '../utils/feathers-instrumentation.js';
import { createFeathersTracingHook, type DatadogTracer, resolveTracerModule } from './feathers.js';

interface TracedCall {
  name: string;
  resource?: string;
  tags?: Record<string, unknown>;
}

interface FakeSpan {
  finished: boolean;
  error?: unknown;
}

/**
 * Models dd-trace's documented `trace()` contract: it awaits the promise-backed
 * callback, finishes the span, and tags a rejected error onto it. Encoding that
 * lifecycle here (rather than a bare recorder) means the hook's reliance on
 * dd-trace to finish/tag — instead of doing it manually — is actually asserted.
 */
class RecordingTracer implements DatadogTracer {
  readonly calls: TracedCall[] = [];
  readonly spans: FakeSpan[] = [];
  async trace<T>(
    name: string,
    options: { resource?: string; tags?: Record<string, unknown> },
    fn: () => Promise<T>
  ): Promise<T> {
    this.calls.push({ name, resource: options.resource, tags: options.tags });
    const span: FakeSpan = { finished: false };
    this.spans.push(span);
    try {
      const result = await fn();
      span.finished = true;
      return result;
    } catch (error) {
      span.error = error;
      span.finished = true;
      throw error;
    }
  }
}

function ctx(path: string, method: string, provider?: string): HookContext {
  return { path, method, params: provider ? { provider } : {} } as unknown as HookContext;
}

/** Deferred promise for interleaving concurrent requests deterministically. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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

  it('is a passthrough when a null tracer is injected', async () => {
    const hook = createFeathersTracingHook('full', { tracer: null });
    let ran = false;
    await hook(ctx('sessions', 'find', 'socketio'), async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('warns once and no-ops when enabled but no tracer resolves', async () => {
    // Inject a resolver that returns null so the enabled-but-unresolved path is
    // deterministic regardless of whether dd-trace is installed in the workspace.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const hook = createFeathersTracingHook('full', { resolveTracer: () => null });
      let ran = false;
      await hook(ctx('sessions', 'find', 'socketio'), async () => {
        ran = true;
      });
      expect(ran).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('no APM tracer is loaded');
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn when a resolver supplies a tracer', async () => {
    const tracer = new RecordingTracer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const hook = createFeathersTracingHook('full', { resolveTracer: () => tracer });
      await hook(ctx('sessions', 'find', 'socketio'), async () => undefined);
      expect(warn).not.toHaveBeenCalled();
      expect(tracer.calls).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('names the span resource <service>.<method> and tags service/method/transport', async () => {
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

  it('adds only a bounded server-authored reason tag when one is present', async () => {
    const tracer = new RecordingTracer();
    const hook = createFeathersTracingHook('full', { tracer });
    const context = ctx('boards', 'get', 'socketio');
    Object.assign(context.params, {
      [FEATHERS_INSTRUMENTATION_REASON]: 'presence_cursor_admission',
      // A wire/client string with the same description is deliberately inert;
      // only the server-held symbol above is read.
      feathersReason: 'unbounded-client-value',
    });

    await hook(context, async () => undefined);

    expect(tracer.calls[0]?.tags).toMatchObject({
      'feathers.transport': 'socketio',
      'feathers.reason': 'presence_cursor_admission',
    });
  });

  it('normalizes unknown methods to custom and internal (no-provider) transport', async () => {
    const tracer = new RecordingTracer();
    const hook = createFeathersTracingHook('full', { tracer });
    await hook(ctx('sessions', 'archive'), async () => undefined);
    expect(tracer.calls[0]?.resource).toBe('sessions.custom');
    expect(tracer.calls[0]?.tags?.['feathers.transport']).toBe('internal');
    expect(tracer.calls[0]?.tags).not.toHaveProperty('feathers.custom_method');
  });

  it.each([
    'connectExecutor',
    'reportTerminationComplete',
    'reportRuntimeTelemetry',
    'reportSdkHealthFailure',
  ])(
    'attributes the bounded tasks.custom method %s without changing its resource',
    async (name) => {
      const tracer = new RecordingTracer();
      const hook = createFeathersTracingHook('full', { tracer });

      await hook(ctx('tasks', name, 'socketio'), async () => undefined);

      expect(tracer.calls[0]?.resource).toBe('tasks.custom');
      expect(tracer.calls[0]?.tags).toMatchObject({
        'feathers.method': 'custom',
        'feathers.custom_method': name,
      });
    }
  );

  it('does not tag an unreviewed custom method', async () => {
    const tracer = new RecordingTracer();
    const hook = createFeathersTracingHook('full', { tracer });

    await hook(ctx('tasks', 'callerSelectedMethod', 'socketio'), async () => undefined);

    expect(tracer.calls[0]?.tags).not.toHaveProperty('feathers.custom_method');
  });

  it('receives the registered custom method name from a real Feathers invocation', async () => {
    const tracer = new RecordingTracer();
    const serviceApp = feathers();
    serviceApp.use(
      'tasks',
      {
        async reportRuntimeTelemetry() {
          return { task_id: 'not-emitted' };
        },
      },
      { methods: ['reportRuntimeTelemetry'] }
    );
    serviceApp.hooks({
      around: { all: [createFeathersTracingHook('full', { tracer })] },
    });

    await (
      serviceApp.service('tasks') as unknown as {
        reportRuntimeTelemetry(data: unknown, params: unknown): Promise<unknown>;
      }
    ).reportRuntimeTelemetry({}, { provider: 'socketio' });

    expect(tracer.calls).toHaveLength(1);
    expect(tracer.calls[0]).toMatchObject({
      resource: 'tasks.custom',
      tags: {
        'feathers.method': 'custom',
        'feathers.custom_method': 'reportRuntimeTelemetry',
      },
    });
  });

  it('skips the high-frequency health probe by default at every depth', async () => {
    const tracer = new RecordingTracer();
    const hook = createFeathersTracingHook('full', { tracer });
    await hook(ctx('health', 'find', 'rest'), async () => undefined);
    expect(tracer.calls).toHaveLength(0);
  });

  it('honors a custom excludedServicePaths list', async () => {
    const tracer = new RecordingTracer();
    const hook = createFeathersTracingHook('full', { tracer, excludedServicePaths: ['boards'] });
    await hook(ctx('boards', 'find', 'socketio'), async () => undefined);
    expect(tracer.calls).toHaveLength(0);
  });

  it('skips calls classified internal via isInternalCall (auth-lookup parity)', async () => {
    const tracer = new RecordingTracer();
    const hook = createFeathersTracingHook('full', {
      tracer,
      isInternalCall: (context) => context.path === 'users',
    });
    await hook(ctx('users', 'get', 'socketio'), async () => undefined);
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

  it('entrypoint mode suppresses sequential nested fan-out to one span', async () => {
    const tracer = new RecordingTracer();
    const hook = createFeathersTracingHook('entrypoint', { tracer });
    await hook(ctx('branches', 'find', 'socketio'), async () => {
      await hook(ctx('sessions', 'get'), async () => undefined);
      await hook(ctx('messages', 'find'), async () => undefined);
    });
    expect(tracer.calls.map((c) => c.resource)).toEqual(['branches.find']);
  });

  it('entrypoint mode suppresses parallel nested fan-out (Promise.all)', async () => {
    const tracer = new RecordingTracer();
    const hook = createFeathersTracingHook('entrypoint', { tracer });
    await hook(ctx('branches', 'find', 'socketio'), async () => {
      await Promise.all([
        hook(ctx('sessions', 'get'), async () => undefined),
        hook(ctx('messages', 'find'), async () => undefined),
      ]);
    });
    expect(tracer.calls.map((c) => c.resource)).toEqual(['branches.find']);
  });

  it('entrypoint mode isolates two concurrent independent requests', async () => {
    const tracer = new RecordingTracer();
    const hook = createFeathersTracingHook('entrypoint', { tracer });
    const gate = deferred();

    // Request A stays open (awaiting the gate) while request B runs its own
    // nested call — proving AsyncLocalStorage keeps the two scopes separate.
    const reqA = hook(ctx('branches', 'find', 'socketio'), async () => {
      await gate.promise;
      await hook(ctx('sessions', 'get'), async () => undefined); // nested in A → suppressed
    });
    const reqB = hook(ctx('boards', 'find', 'socketio'), async () => {
      await hook(ctx('cards', 'find'), async () => undefined); // nested in B → suppressed
      gate.resolve();
    });
    await Promise.all([reqA, reqB]);

    // Exactly the two top-level requests are traced; neither nested call leaks.
    expect(tracer.calls.map((c) => c.resource).sort()).toEqual(['boards.find', 'branches.find']);
  });

  it('propagates errors while finishing and tagging the span', async () => {
    const tracer = new RecordingTracer();
    const hook = createFeathersTracingHook('full', { tracer });
    const boom = new Error('boom');
    await expect(
      hook(ctx('sessions', 'find', 'socketio'), async () => {
        throw boom;
      })
    ).rejects.toThrow('boom');
    expect(tracer.spans).toHaveLength(1);
    expect(tracer.spans[0]?.finished).toBe(true);
    expect(tracer.spans[0]?.error).toBe(boom);
  });
});

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
