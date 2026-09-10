import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatadogTracer } from '@agor/core/tracing/datadog';
import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { ToolDispatcher, type ToolHandler, toolDispatcherProxy } from './register-tool-proxy.js';
import { createMcpTracing } from './tracing.js';

function recordingTracer() {
  const calls: { name: string; options: Parameters<DatadogTracer['trace']>[1] }[] = [];
  const tracer: DatadogTracer = {
    trace(name, options, work) {
      calls.push({ name, options });
      return work();
    },
  };
  return { tracer, calls };
}

describe('MCP tracing', () => {
  it('keeps one measured server span per facade call, async parentage and caller isolation', async () => {
    const active = new AsyncLocalStorage<string>();
    const tenant = new AsyncLocalStorage<string>();
    const calls: { resource: string; parent?: string; tags: Record<string, unknown> }[] = [];
    const tracer: DatadogTracer = {
      trace(_name, options, work) {
        const tags = { ...options.tags };
        calls.push({ resource: options.resource!, parent: active.getStore(), tags });
        expect(options.measured).toBe(true);
        return active.run(options.resource!, () =>
          work({
            setTag: (key, value) => {
              tags[key] = value;
            },
          })
        );
      },
    };
    const tracing = createMcpTracing('entrypoint', { tracer });
    const handlers = new Map<string, ToolHandler>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: ToolHandler) =>
        handlers.set(name, handler),
    } as unknown as McpServer;
    const dispatcher = new ToolDispatcher();
    const failure = new Error('secret exception');
    tracing
      .toolProxy(toolDispatcherProxy(server, dispatcher))
      .registerTool('agor_test', {}, async () => {
        await Promise.resolve();
        expect(active.getStore()).toBe('agor_test');
        if (tenant.getStore() === 'tenant-b') throw failure;
        return { content: [], tenant: tenant.getStore() };
      });
    tracing.toolProxy(server, dispatcher).registerTool('agor_execute_tool', {}, async () => {
      try {
        return await dispatcher.get('agor_test')!.handler({ secret: 'private args' });
      } catch {
        return { isError: true, content: [{ type: 'text' as const, text: 'secret result' }] };
      }
    });
    const results = await Promise.all(
      ['tenant-a', 'tenant-b'].map((id) =>
        tenant.run(id, () =>
          active.run(id, () => handlers.get('agor_execute_tool')!({ tool_name: 'agor_test' }))
        )
      )
    );
    expect(results).toEqual([
      { content: [], tenant: 'tenant-a' },
      { isError: true, content: [{ type: 'text', text: 'secret result' }] },
    ]);
    expect(calls).toEqual([
      {
        resource: 'agor_test',
        parent: 'tenant-a',
        tags: { 'mcp.tool': 'agor_test', 'span.kind': 'server', 'mcp.outcome': 'success' },
      },
      {
        resource: 'agor_test',
        parent: 'tenant-b',
        tags: {
          'mcp.tool': 'agor_test',
          'span.kind': 'server',
          'mcp.outcome': 'exception',
          error: true,
        },
      },
    ]);
    expect(active.getStore()).toBeUndefined();
    expect(tenant.getStore()).toBeUndefined();
    expect(JSON.stringify(calls.map((call) => call.tags))).not.toMatch(/secret|tenant/);
  });

  it('records safe errors without exposing exceptions to the tracer, even when instrumentation fails', async () => {
    for (const mode of ['normal', 'before', 'after', 'tag'] as const) {
      const tags: Record<string, unknown>[] = [];
      const tracer: DatadogTracer = {
        trace(_name, _options, work) {
          if (mode === 'before') throw new Error('tracer failed');
          const data: Record<string, unknown> = {};
          tags.push(data);
          const result = work({
            setTag: (key, value) => {
              if (mode === 'tag') throw new Error('tag failed');
              data[key] = value;
            },
          });
          if (mode === 'after') throw new Error('tracer failed');
          // The traced callback must resolve, never hand the tracer a raw error.
          Promise.resolve(result).catch(() => {
            throw new Error('raw error reached tracer');
          });
          return result;
        },
      };
      const handlers = new Map<string, ToolHandler>();
      const server = {
        registerTool: (name: string, _config: unknown, handler: ToolHandler) =>
          handlers.set(name, handler),
      } as unknown as McpServer;
      const proxy = createMcpTracing('full', { tracer }).toolProxy(server);
      const failure = new Error('secret credential');
      const reject = vi.fn(() => {
        throw failure;
      });
      proxy.registerTool('agor_fail', {}, reject);
      await expect(handlers.get('agor_fail')!({})).rejects.toBe(failure);
      expect(reject).toHaveBeenCalledTimes(1);
      const result = { isError: true, content: [{ type: 'text' as const, text: 'secret output' }] };
      proxy.registerTool('agor_result', {}, async () => result);
      expect(await handlers.get('agor_result')!({})).toBe(result);
      if (mode === 'normal')
        expect(tags).toEqual([
          { 'mcp.outcome': 'exception', error: true },
          { 'mcp.outcome': 'tool_error', error: true },
        ]);
      expect(JSON.stringify(tags)).not.toContain('secret');
    }
  });

  it('does not resolve a tracer when tracing is off', () => {
    const resolveTracer = vi.fn();
    const tracing = createMcpTracing('off', { resolveTracer });
    const result = {};
    expect(tracing.request({ method: 'tools/call' }, () => result)).toBe(result);
    const server = {} as McpServer;
    expect(tracing.toolProxy(server)).toBe(server);
    expect(resolveTracer).not.toHaveBeenCalled();
  });

  it('preserves passthrough behavior without an optional tracer', () => {
    const tracing = createMcpTracing('full', { tracer: null });
    const promise = Promise.resolve({ isError: true });
    expect(tracing.request(undefined, () => promise)).toBe(promise);
    const server = {} as McpServer;
    expect(tracing.toolProxy(server)).toBe(server);
  });

  it.each(['entrypoint', 'full'] as const)('bounds request tags at %s depth', (depth) => {
    const { tracer, calls } = recordingTracer();
    const tracing = createMcpTracing(depth, { tracer });
    for (const method of [
      'tools/call',
      'tools/list',
      'initialize',
      'server/discover',
      'resources/read',
      'private-data',
    ]) {
      tracing.request(
        { method, id: 'sensitive-id', params: { arguments: 'private-data' } },
        () => 1
      );
    }
    tracing.request([{ method: 'private-data' }], () => 1);
    tracing.request(null, () => 1);
    expect(calls.map((call) => call.options.resource)).toEqual([
      'tools/call',
      'tools/list',
      'initialize',
      'server/discover',
      'resources/read',
      'other',
      'batch',
      'other',
    ]);
    expect(JSON.stringify(calls)).not.toContain('private-data');
    expect(JSON.stringify(calls)).not.toContain('sensitive-id');
  });

  it('traces the same registered handler through direct and facade dispatch without reading args', async () => {
    const { tracer, calls } = recordingTracer();
    const tracing = createMcpTracing('entrypoint', { tracer });
    const direct = new Map<string, ToolHandler>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: ToolHandler) =>
        direct.set(name, handler),
    } as unknown as McpServer;
    const dispatcher = new ToolDispatcher();
    const proxy = tracing.toolProxy(toolDispatcherProxy(server, dispatcher));
    const args = { private: 'secret' };
    const extra = {};
    const result = {
      isError: true,
      content: [{ type: 'text' as const, text: 'sensitive output' }],
    };
    const handler = vi.fn(async (received: unknown, receivedExtra?: unknown) => {
      expect(received).toBe(args);
      expect(receivedExtra).toBe(extra);
      return result;
    });
    proxy.registerTool('agor_boards_get', {}, handler);
    expect(await direct.get('agor_boards_get')!(args, extra)).toBe(result);
    expect(await dispatcher.get('agor_boards_get')!.handler(args, extra)).toBe(result);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(
      Array.from({ length: 2 }, () => ({
        name: 'mcp.tool',
        options: {
          resource: 'agor_boards_get',
          measured: true,
          tags: { 'mcp.tool': 'agor_boards_get', 'span.kind': 'server' },
        },
      }))
    );
    expect(JSON.stringify(calls)).not.toMatch(/secret|sensitive/);
  });

  it('preserves rejection identity and concurrent caller context', async () => {
    const { tracer } = recordingTracer();
    const tracing = createMcpTracing('full', { tracer });
    const identity = new AsyncLocalStorage<string>();
    const work = (tenant: string) =>
      identity.run(tenant, () =>
        tracing.request({ method: 'tools/call' }, async () => {
          await Promise.resolve();
          return identity.getStore();
        })
      );
    expect(await Promise.all([work('tenant-a'), work('tenant-b')])).toEqual([
      'tenant-a',
      'tenant-b',
    ]);
    expect(identity.getStore()).toBeUndefined();
    const error = new Error('expected');
    await expect(tracing.request({}, () => Promise.reject(error))).rejects.toBe(error);
    expect(() =>
      tracing.request({}, () => {
        throw error;
      })
    ).toThrow(error);
  });
});
