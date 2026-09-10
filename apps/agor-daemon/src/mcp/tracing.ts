import { AsyncLocalStorage } from 'node:async_hooks';
import type { ApmTraceServiceDepth } from '@agor/core/config';
import { type DatadogTracer, setSpanTag, traceBestEffort } from '@agor/core/tracing/datadog';
import type { McpServer } from '@modelcontextprotocol/server';
import { resolveTracerModule } from '../tracing/datadog.js';
import {
  MCP_EXECUTE_TOOL_NAME,
  type ToolDispatcher,
  type ToolHandler,
  wrapRegisterTool,
} from './register-tool-proxy.js';

/** Bounded protocol labels, not client-provided method strings or request IDs. */
const REQUEST_METHODS = new Set([
  'initialize',
  'ping',
  'server/discover',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/templates/list',
  'resources/read',
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
 * BEFORE the dispatcher captures the handler. A facade invocation uses its
 * registered target's resource and suppresses only that exact delegated wrapper.
 * No args, results, tenant/user IDs or secrets enter tags. Target names are
 * accepted only after lookup in the request-local registered dispatcher.
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

  // Independent of authenticated tenant context; never used for authorization.
  const delegation = tracer
    ? new AsyncLocalStorage<
        | {
            handler: ToolHandler;
            exception: boolean;
            consumed: boolean;
          }
        | undefined
      >()
    : null;

  return {
    request<T>(body: unknown, work: () => T): T {
      if (!tracer) return work();
      const method = requestMethod(body);
      return traceBestEffort(tracer, 'mcp.request', { 'mcp.method': method }, work, {
        resource: method,
      });
    },
    toolProxy(server: McpServer, dispatcher?: ToolDispatcher): McpServer {
      if (!tracer) return server;
      return wrapRegisterTool(server, (register, name, config, handler) => {
        const invoke: ToolHandler = async (args, extra) => {
          const parent = delegation?.getStore();
          if (parent?.handler === invoke && !parent.consumed) {
            parent.consumed = true;
            // Consume the delegation only for this call. Genuine nested calls
            // (including the same tool) must still receive their own spans.
            return delegation!.run(undefined, async () => {
              try {
                return await handler(args, extra);
              } catch (error) {
                parent.exception = true;
                throw error;
              }
            });
          }

          const candidate =
            name === MCP_EXECUTE_TOOL_NAME && args && typeof args === 'object'
              ? (args as { tool_name?: unknown }).tool_name
              : undefined;
          const target = typeof candidate === 'string' ? dispatcher?.get(candidate) : undefined;
          const resource = target ? (candidate as string) : name;
          const outcome = await traceBestEffort(
            tracer,
            'mcp.tool',
            {
              'mcp.tool': resource,
              'span.kind': 'server',
            },
            async (span) => {
              const state = target
                ? { handler: target.handler, exception: false, consumed: false }
                : undefined;
              try {
                const result = await delegation!.run(state, () => handler(args, extra));
                const isError =
                  !!result &&
                  typeof result === 'object' &&
                  (result as { isError?: unknown }).isError === true;
                setSpanTag(
                  span,
                  'mcp.outcome',
                  state?.exception ? 'exception' : isError ? 'tool_error' : 'success'
                );
                if (isError || state?.exception) setSpanTag(span, 'error', true);
                return { ok: true as const, result };
              } catch (error) {
                setSpanTag(span, 'mcp.outcome', 'exception');
                setSpanTag(span, 'error', true);
                // dd-trace automatically records thrown errors' messages/stacks.
                // Keep arbitrary error content out of this span while preserving
                // the exact rejection for the SDK/caller outside the callback.
                return { ok: false as const, error };
              }
            },
            { resource, measured: true }
          );
          if (!outcome.ok) throw outcome.error;
          return outcome.result;
        };
        return register(name, config, invoke);
      });
    },
  };
}
