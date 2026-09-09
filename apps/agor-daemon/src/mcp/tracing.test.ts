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
        options: { resource: 'agor_boards_get', tags: { 'mcp.tool': 'agor_boards_get' } },
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
