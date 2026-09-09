import type { ApmTraceServiceDepth } from '@agor/core/config';
import type { DatadogTracer } from '@agor/core/tracing/datadog';
import type { McpServer } from '@modelcontextprotocol/server';
import { resolveTracerModule } from '../tracing/feathers.js';
import { wrapRegisterTool } from './register-tool-proxy.js';

/** Bounded protocol labels, not client-provided method strings or request IDs. */
const REQUEST_METHODS = new Set([
  'initialize',
  'ping',
  'server/discover',
  'tools/list',
  'tools/call',
  'notifications/initialized',
  'notifications/cancelled',
]);

function requestMethod(body: unknown): string {
  if (Array.isArray(body)) return 'batch';
  const method = body && typeof body === 'object' ? (body as { method?: unknown }).method : null;
  return typeof method === 'string' && REQUEST_METHODS.has(method) ? method : 'other';
}

/**
 * One request span includes admission; tool spans cover only registered handlers.
 * Both direct tools/call and the execute facade must register through toolProxy
 * BEFORE the dispatcher captures the handler. The facade and target are nested
 * spans, not independent requests. No args, results, tenant/user IDs or secrets
 * enter tags. Registration names are server-authored and bounded by the catalog.
 */
export function createMcpTracing(
  depth: ApmTraceServiceDepth,
  options: { tracer?: DatadogTracer | null; resolveTracer?: () => DatadogTracer | null } = {}
) {
  const tracer =
    depth === 'off'
      ? null
      : options.tracer !== undefined
        ? options.tracer
        : (options.resolveTracer ?? resolveTracerModule)();

  return {
    request<T>(body: unknown, work: () => T): T {
      if (!tracer) return work();
      const method = requestMethod(body);
      return tracer.trace(
        'mcp.request',
        { resource: method, tags: { 'mcp.method': method } },
        work
      );
    },
    toolProxy(server: McpServer): McpServer {
      if (!tracer) return server;
      return wrapRegisterTool(server, (register, name, config, handler) =>
        register(name, config, (args, extra) =>
          tracer.trace('mcp.tool', { resource: name, tags: { 'mcp.tool': name } }, () =>
            handler(args, extra)
          )
        )
      );
    },
  };
}
