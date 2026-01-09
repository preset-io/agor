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
 * - `auth.oauth_token_url` - OAuth token endpoint URL
 * - `auth.oauth_client_id` - OAuth client ID
 * - `auth.oauth_client_secret` - OAuth client secret
 * - `auth.oauth_scope` - OAuth scopes
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
 * - `user.env.*` - User's environment variables ONLY (not system vars)
 *
 * Security:
 * The context is restricted to user-defined environment variables only.
 * This prevents global MCP configs from exfiltrating system/daemon secrets.
 *
 * The list of user-defined keys is communicated via AGOR_USER_ENV_KEYS env var
 * (set by createUserProcessEnvironment when daemon spawns executor).
 *
 * Usage:
 * In the executor process, call buildMCPTemplateContextFromEnv(process.env).
 * It will automatically filter to only user-defined variables.
 */

import { AGOR_USER_ENV_KEYS_VAR } from '../config/env-resolver';
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
 * Result of resolving templates in an MCP server configuration.
 */
export interface MCPTemplateResolutionResult {
  /** Resolved server configuration (may have undefined fields if templates failed) */
  server: MCPServer;
  /** List of fields that had templates but resolved to empty/undefined */
  unresolvedFields: string[];
  /** Whether the server is usable (critical fields resolved successfully) */
  isValid: boolean;
  /** Human-readable error message if not valid */
  errorMessage?: string;
}

/**
 * Build template context from process environment.
 *
 * SECURITY: Only includes user-defined environment variables, not system vars.
 * The list of user-defined keys is read from AGOR_USER_ENV_KEYS env var
 * (set by createUserProcessEnvironment when daemon spawns executor).
 *
 * This prevents global MCP configs from accessing system secrets like
 * AGOR_MASTER_SECRET, database credentials, or other daemon internals.
 *
 * @param env - Environment object (typically process.env)
 * @returns Template context for MCP config resolution (user vars only)
 */
export function buildMCPTemplateContextFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): MCPTemplateContext {
  // Get the list of user-defined env var keys (set by daemon)
  const userEnvKeysStr = env[AGOR_USER_ENV_KEYS_VAR];
  const allowedKeys = userEnvKeysStr ? new Set(userEnvKeysStr.split(',')) : new Set<string>();

  // Filter to only user-defined variables
  const userEnv: Record<string, string> = {};
  for (const key of allowedKeys) {
    const value = env[key];
    if (value !== undefined) {
      userEnv[key] = value;
    }
  }

  if (allowedKeys.size > 0) {
    console.log(
      `   🔐 MCP template context: ${allowedKeys.size} user env var(s) available for templates`
    );
  }

  return {
    user: {
      env: userEnv,
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
 * - `auth.oauth_token_url` - OAuth token endpoint URL
 * - `auth.oauth_client_id` - OAuth client ID
 * - `auth.oauth_client_secret` - OAuth client secret
 * - `auth.oauth_scope` - OAuth scopes
 *
 * Returns a NEW server object with resolved values.
 * Does not mutate the input server.
 *
 * @param server - MCP server with potentially templated fields
 * @param context - Template context
 * @returns Resolution result with server, validation status, and any errors
 */
export function resolveMcpServerTemplates(
  server: MCPServer,
  context: MCPTemplateContext
): MCPTemplateResolutionResult {
  const resolved: MCPServer = { ...server };
  const unresolvedFields: string[] = [];

  // Track original templated fields to detect unresolved templates
  const hadUrlTemplate = server.url && containsTemplate(server.url);

  // Resolve URL (for HTTP/SSE transport)
  if (server.url) {
    resolved.url = resolveStringValue('url', server.url, context);
    if (hadUrlTemplate && !resolved.url) {
      unresolvedFields.push('url');
    }
  }

  // Resolve env vars (track individual unresolved vars)
  if (server.env) {
    const resolvedEnv: Record<string, string> = {};
    for (const [key, templateValue] of Object.entries(server.env)) {
      const hadTemplate = containsTemplate(templateValue);
      const resolvedValue = resolveStringValue(`env.${key}`, templateValue, context);
      if (resolvedValue !== undefined) {
        resolvedEnv[key] = resolvedValue;
      } else if (hadTemplate) {
        unresolvedFields.push(`env.${key}`);
      }
    }
    resolved.env = Object.keys(resolvedEnv).length > 0 ? resolvedEnv : undefined;
  }

  // Resolve auth fields
  if (server.auth) {
    const resolvedAuth: MCPAuth = { ...server.auth };

    if (server.auth.token) {
      const hadTemplate = containsTemplate(server.auth.token);
      resolvedAuth.token = resolveStringValue('auth.token', server.auth.token, context);
      if (hadTemplate && !resolvedAuth.token) {
        unresolvedFields.push('auth.token');
      }
    }
    if (server.auth.api_url) {
      const hadTemplate = containsTemplate(server.auth.api_url);
      resolvedAuth.api_url = resolveStringValue('auth.api_url', server.auth.api_url, context);
      if (hadTemplate && !resolvedAuth.api_url) {
        unresolvedFields.push('auth.api_url');
      }
    }
    if (server.auth.api_token) {
      const hadTemplate = containsTemplate(server.auth.api_token);
      resolvedAuth.api_token = resolveStringValue('auth.api_token', server.auth.api_token, context);
      if (hadTemplate && !resolvedAuth.api_token) {
        unresolvedFields.push('auth.api_token');
      }
    }
    if (server.auth.api_secret) {
      const hadTemplate = containsTemplate(server.auth.api_secret);
      resolvedAuth.api_secret = resolveStringValue(
        'auth.api_secret',
        server.auth.api_secret,
        context
      );
      if (hadTemplate && !resolvedAuth.api_secret) {
        unresolvedFields.push('auth.api_secret');
      }
    }

    // OAuth 2.0 fields (all optional - don't default to env vars, don't track as unresolved)
    if (server.auth.type === 'oauth') {
      // OAuth token URL (optional - can be auto-detected)
      if (server.auth.oauth_token_url) {
        const _hadTemplate = containsTemplate(server.auth.oauth_token_url);
        resolvedAuth.oauth_token_url = resolveStringValue(
          'auth.oauth_token_url',
          server.auth.oauth_token_url,
          context
        );
        // Don't track as unresolved - it's optional
      }

      // OAuth client ID (optional - only resolve if provided)
      if (server.auth.oauth_client_id) {
        const _hadTemplate = containsTemplate(server.auth.oauth_client_id);
        resolvedAuth.oauth_client_id = resolveStringValue(
          'auth.oauth_client_id',
          server.auth.oauth_client_id,
          context
        );
        // Don't track as unresolved - it's optional
      }

      // OAuth client secret (optional - only resolve if provided)
      if (server.auth.oauth_client_secret) {
        const _hadTemplate = containsTemplate(server.auth.oauth_client_secret);
        resolvedAuth.oauth_client_secret = resolveStringValue(
          'auth.oauth_client_secret',
          server.auth.oauth_client_secret,
          context
        );
        // Don't track as unresolved - it's optional
      }

      // OAuth scope (optional)
      if (server.auth.oauth_scope) {
        const _hadTemplate = containsTemplate(server.auth.oauth_scope);
        resolvedAuth.oauth_scope = resolveStringValue(
          'auth.oauth_scope',
          server.auth.oauth_scope,
          context
        );
        // Don't track as unresolved - it's optional
      }

      // Grant type defaults to client_credentials if not provided
      resolvedAuth.oauth_grant_type = server.auth.oauth_grant_type || 'client_credentials';
    }

    resolved.auth = resolvedAuth;
  }

  // Determine validity - URL is critical for HTTP/SSE transports
  const isHttpTransport = server.transport === 'http' || server.transport === 'sse';
  const urlRequired = isHttpTransport && hadUrlTemplate;
  const urlMissing = urlRequired && !resolved.url;

  const isValid = !urlMissing;
  let errorMessage: string | undefined;

  if (!isValid) {
    const missingVars = unresolvedFields
      .map((f) => {
        // Extract the template variable name for better error messages
        let originalValue: string | undefined;
        if (f === 'url') {
          originalValue = server.url;
        } else if (f.startsWith('env.')) {
          originalValue = server.env?.[f.slice(4)];
        } else if (f.startsWith('auth.') && server.auth) {
          const authKey = f.slice(5) as keyof MCPAuth;
          const authValue = server.auth[authKey];
          originalValue = typeof authValue === 'string' ? authValue : undefined;
        }
        return originalValue || f;
      })
      .join(', ');
    errorMessage = `MCP server "${server.name}" has unresolved required templates: ${missingVars}. Set the corresponding environment variables in your user settings.`;
  }

  return {
    server: resolved,
    unresolvedFields,
    isValid,
    errorMessage,
  };
}

/**
 * Resolve templates in multiple MCP server configurations.
 *
 * @param servers - Array of MCP servers
 * @param context - Template context
 * @returns Array of resolution results
 */
export function resolveMcpServersTemplates(
  servers: MCPServer[],
  context: MCPTemplateContext
): MCPTemplateResolutionResult[] {
  return servers.map((server) => resolveMcpServerTemplates(server, context));
}
