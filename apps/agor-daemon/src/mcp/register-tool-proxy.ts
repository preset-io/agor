import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Tool-registration intercept primitive shared by the MCP server proxies.
 *
 * Each `McpServer.registerTool(name, config, handler)` call goes through
 * `intercept(original, name, config, handler)`, which decides what to do:
 *
 * - silently skip the registration (`readOnlyProxy` does this for mutating
 *   tools when the worktrees domain is in read-only tier);
 * - transform `config` / `handler` before forwarding (e.g. add a
 *   `[Deprecated alias]` prefix to the description, log on invocation);
 * - register the tool under multiple names (e.g. `withBranchAliases`
 *   mirrors every `agor_worktrees_*` registration as `agor_branches_*`).
 *
 * The proxy uses `Object.create(server)` so it passes `instanceof McpServer`
 * and shares every other method, then overrides only `registerTool`.
 * The cast on `registerTool` is required because the SDK exposes it as an
 * overloaded generic that TypeScript can't represent with the replacement
 * function's signature.
 */

export type ToolConfig = Record<string, unknown>;
export type ToolHandler = (args: unknown, extra?: unknown) => unknown;
export type RegisterTool = (name: string, config: ToolConfig, handler: ToolHandler) => unknown;

export function wrapRegisterTool(
  server: McpServer,
  intercept: (
    original: RegisterTool,
    name: string,
    config: ToolConfig,
    handler: ToolHandler
  ) => unknown
): McpServer {
  const proxy = Object.create(server) as McpServer;
  const original = server.registerTool.bind(server) as unknown as RegisterTool;
  (proxy as unknown as { registerTool: RegisterTool }).registerTool = (name, config, handler) =>
    intercept(original, name, config, handler);
  return proxy;
}
