/**
 * MCP Configuration Template Resolver
 *
 * Resolves Handlebars templates in MCP server configurations, allowing
 * user-specific credentials to be injected at runtime.
 *
 * Templatable fields:
 * - `url` - Server URL (for HTTP/SSE transport)
 * - `env.*` - Environment variables
 * - `auth.token` - Bearer token
 * - `auth.api_url` - JWT API URL
 * - `auth.api_token` - JWT API token
 * - `auth.api_secret` - JWT API secret
 *
 * Example:
 * ```json
 * {
 *   "url": "https://mcp.example.com/{{ user.env.TENANT_ID }}",
 *   "env": {
 *     "GITHUB_TOKEN": "{{ user.env.GITHUB_TOKEN }}"
 *   },
 *   "auth": {
 *     "type": "bearer",
 *     "token": "{{ user.env.API_TOKEN }}"
 *   }
 * }
 * ```
 *
 * Template Context:
 * - `user.env.*` - User's environment variables (from process.env in executor)
 *
 * The context is intentionally minimal (only user.env.*) for security:
 * - MCP configs can be global-scoped (shared across users)
 * - Exposing worktree/session context could leak info across boundaries
 * - The primary use case is credential injection, not dynamic configuration
 *
 * Usage:
 * In the executor process, user environment variables are already available
 * in process.env (populated by createUserProcessEnvironment when spawning).
 * Use buildMCPTemplateContextFromEnv(process.env) to build the context.
 */

import { renderTemplate } from '../templates/handlebars-helpers';
import type { MCPAuth, MCPServer } from '../types';

/**
 * Template context available for MCP configuration resolution.
 * Intentionally minimal - only user environment variables are exposed.
 */
export interface MCPTemplateContext {
  user: {
    env: Record<string, string>;
  };
}

/**
 * Build template context from process environment.
 *
 * In the executor, process.env already contains the user's decrypted
 * environment variables (merged by createUserProcessEnvironment when
 * the daemon spawns the executor).
 *
 * @param env - Environment object (typically process.env)
 * @returns Template context for MCP config resolution
 */
export function buildMCPTemplateContextFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): MCPTemplateContext {
  // Filter out undefined values and convert to Record<string, string>
  const filteredEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      filteredEnv[key] = value;
    }
  }
  return {
    user: {
      env: filteredEnv,
    },
  };
}

/**
 * Check if a string contains Handlebars template syntax
 */
function containsTemplate(value: string): boolean {
  return value.includes('{{') && value.includes('}}');
}

/**
 * Resolve templates in a single string value.
 *
 * @param fieldName - Field name (for logging)
 * @param templateValue - Value that may contain {{ templates }}
 * @param context - Template context
 * @returns Resolved value, or undefined if resolution failed/empty
 */
function resolveStringValue(
  fieldName: string,
  templateValue: string,
  context: MCPTemplateContext
): string | undefined {
  if (!containsTemplate(templateValue)) {
    // Not a template, pass through as-is
    return templateValue;
  }

  try {
    // Cast to satisfy renderTemplate's signature - MCPTemplateContext is compatible at runtime
    const resolved = renderTemplate(templateValue, context as unknown as Record<string, unknown>);

    if (!resolved || resolved.trim() === '') {
      // Template resolved to empty - user probably hasn't set the var
      // Log at debug level since this is expected during setup
      console.log(`   ℹ️  MCP "${fieldName}" resolved to empty (user may need to set env var)`);
      return undefined;
    }

    return resolved;
  } catch (error) {
    // Template syntax error or other failure
    console.warn(
      `   ⚠️  Failed to resolve MCP template "${fieldName}":`,
      error instanceof Error ? error.message : String(error)
    );
    return undefined;
  }
}

/**
 * Resolve templates in MCP auth configuration.
 *
 * @param auth - Auth config that may contain templated values
 * @param context - Template context
 * @returns New auth object with resolved values, or undefined if auth is undefined
 */
function resolveMcpServerAuth(
  auth: MCPAuth | undefined,
  context: MCPTemplateContext
): MCPAuth | undefined {
  if (!auth) return undefined;

  const resolved: MCPAuth = { ...auth };

  // Resolve bearer token
  if (auth.token) {
    resolved.token = resolveStringValue('auth.token', auth.token, context);
  }

  // Resolve JWT fields
  if (auth.api_url) {
    resolved.api_url = resolveStringValue('auth.api_url', auth.api_url, context);
  }
  if (auth.api_token) {
    resolved.api_token = resolveStringValue('auth.api_token', auth.api_token, context);
  }
  if (auth.api_secret) {
    resolved.api_secret = resolveStringValue('auth.api_secret', auth.api_secret, context);
  }

  return resolved;
}

/**
 * Resolve templates in MCP server env vars.
 *
 * Returns a NEW object (doesn't mutate input).
 * Env vars that resolve to empty or fail are excluded from output.
 *
 * @param envTemplate - Env vars that may contain {{ templates }}
 * @param context - Template context with user.env
 * @returns Resolved env vars (new object), or undefined if all empty
 */
export function resolveMcpServerEnv(
  envTemplate: Record<string, string> | undefined,
  context: MCPTemplateContext
): Record<string, string> | undefined {
  if (!envTemplate || Object.keys(envTemplate).length === 0) {
    return undefined;
  }

  const result: Record<string, string> = {};

  for (const [key, templateValue] of Object.entries(envTemplate)) {
    const resolved = resolveStringValue(`env.${key}`, templateValue, context);
    if (resolved !== undefined) {
      result[key] = resolved;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Resolve templates in an MCP server configuration.
 *
 * Resolves templates in these fields:
 * - `url` - Server URL
 * - `env.*` - Environment variables
 * - `auth.token` - Bearer token
 * - `auth.api_url` - JWT API URL
 * - `auth.api_token` - JWT API token
 * - `auth.api_secret` - JWT API secret
 *
 * Returns a NEW server object with resolved values.
 * Does not mutate the input server.
 *
 * @param server - MCP server with potentially templated fields
 * @param context - Template context
 * @returns New server object with resolved values
 */
export function resolveMcpServerTemplates(
  server: MCPServer,
  context: MCPTemplateContext
): MCPServer {
  const resolved: MCPServer = { ...server };

  // Resolve URL (for HTTP/SSE transport)
  if (server.url) {
    resolved.url = resolveStringValue('url', server.url, context);
  }

  // Resolve env vars
  resolved.env = resolveMcpServerEnv(server.env, context);

  // Resolve auth fields
  resolved.auth = resolveMcpServerAuth(server.auth, context);

  return resolved;
}

/**
 * Resolve templates in multiple MCP server configurations.
 *
 * @param servers - Array of MCP servers
 * @param context - Template context
 * @returns New array with resolved servers
 */
export function resolveMcpServersTemplates(
  servers: MCPServer[],
  context: MCPTemplateContext
): MCPServer[] {
  return servers.map((server) => resolveMcpServerTemplates(server, context));
}
