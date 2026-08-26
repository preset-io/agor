/**
 * MCP Configuration Template Resolver
 *
 * Resolves Handlebars templates in MCP server configurations, allowing
 * user-specific credentials to be injected at runtime.
 *
 * Templatable fields:
 * - `url` - Server URL (for HTTP/SSE transport)
 * - `env.*` - Environment variables
 * - `headers.*` - Custom HTTP headers for remote transports
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
 *   "headers": {
 *     "DD-API-KEY": "{{ user.env.DATADOG_API_KEY }}"
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

import Handlebars from 'handlebars';
import { AGOR_USER_ENV_KEYS_VAR } from '../config/env-resolver';
import { renderTemplate } from '../templates/handlebars-helpers';
import type { MCPAuth, MCPServer } from '../types';
import {
  containsTemplate,
  hasTemplateMarker,
  isUserEnvPlaceholder,
  isValidMCPHttpUrlTemplate,
} from './template-patterns';

export { containsTemplate, hasTemplateMarker, isUserEnvPlaceholder };

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

export interface MCPTemplateDependencies {
  keys: Set<string>;
  valid: boolean;
  mightReferenceUserEnv: boolean;
}

const MCP_TEMPLATE_HELPERS = new Set([
  'add',
  'sub',
  'mul',
  'div',
  'mod',
  'uppercase',
  'lowercase',
  'replace',
  'eq',
  'neq',
  'gt',
  'lt',
  'gte',
  'lte',
  'default',
  'json',
  'isDefined',
]);

/** Parse with the same Handlebars grammar as rendering and conservatively bind user.env paths. */
export function extractMCPTemplateDependencies(server: MCPServer): MCPTemplateDependencies {
  const keys = new Set<string>();
  let valid = true;
  let mightReferenceUserEnv = false;
  const seen = new WeakSet<object>();
  const values = [
    server.url,
    ...Object.values(server.env ?? {}),
    ...Object.values(server.headers ?? {}),
    ...Object.values(server.auth ?? {}),
  ];
  const walk = (node: unknown, parent?: Record<string, unknown>, parentKey?: string): void => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    const record = node as Record<string, unknown>;
    if (
      record.type === 'BlockStatement' ||
      record.type === 'PartialStatement' ||
      record.type === 'PartialBlockStatement' ||
      record.type === 'Decorator' ||
      record.type === 'DecoratorBlock'
    ) {
      // Relative scope changes (`with`, `each`, custom blocks) make paths
      // context-dependent. Gateway mediation intentionally refuses them.
      valid = false;
    }
    if (record.type === 'PathExpression' && typeof record.original === 'string') {
      const original = record.original;
      const exact = /^user\.env\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(original);
      const isCallee =
        parentKey === 'path' &&
        (parent?.type === 'MustacheStatement' || parent?.type === 'SubExpression') &&
        ((Array.isArray(parent.params) && parent.params.length > 0) ||
          (parent.hash &&
            typeof parent.hash === 'object' &&
            Array.isArray((parent.hash as Record<string, unknown>).pairs) &&
            ((parent.hash as Record<string, unknown>).pairs as unknown[]).length > 0));
      if (exact && record.data !== true && record.depth === 0 && !isCallee) {
        keys.add(exact[1]!);
        mightReferenceUserEnv = true;
      } else if (isCallee && MCP_TEMPLATE_HELPERS.has(original)) {
        // Static helper names are safe: their arguments are walked below and
        // therefore bind every user.env dependency used by nested/fallback
        // expressions.
      } else if (
        original === 'lookup' ||
        original.includes('user.env') ||
        original.includes('user/env') ||
        original.startsWith('@root') ||
        original.startsWith('this.') ||
        original.startsWith('./') ||
        (typeof record.depth === 'number' && record.depth > 0)
      ) {
        valid = false;
        mightReferenceUserEnv = true;
      } else {
        // The gateway grammar contains only literals, the registered static
        // helpers above, and absolute user.env.KEY values. Unknown/dynamic
        // paths may render today but are deliberately not mediable.
        valid = false;
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (Array.isArray(value))
        value.forEach((item) => {
          walk(item, record, key);
        });
      else walk(value, record, key);
    }
  };
  for (const value of values) {
    if (typeof value !== 'string' || !hasTemplateMarker(value)) continue;
    if (/user[./]env|@root|\blookup\b|{{[#/]?(?:with|each)\b/.test(value)) {
      mightReferenceUserEnv = true;
    }
    if (/{{[^}]*?(?:@root|\bthis\.|\.\/|\blookup\b)|{{[#/]?(?:with|each)\b/.test(value)) {
      valid = false;
    }
    try {
      walk(Handlebars.parse(value));
    } catch {
      valid = false;
    }
  }
  return { keys, valid, mightReferenceUserEnv };
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

  return {
    user: {
      env: userEnv,
    },
  };
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
  context: MCPTemplateContext,
  malformedFields: string[]
): string | undefined {
  if (!hasTemplateMarker(templateValue)) {
    // Not a template, pass through as-is
    return templateValue;
  }

  if (!containsTemplate(templateValue)) {
    addUnresolvedField(malformedFields, fieldName);
    console.warn(
      `[mcp-template] resolution_failed field_family=${templateFieldFamily(fieldName)} error_type=UnbalancedMarker`
    );
    return undefined;
  }

  try {
    // Cast to satisfy renderTemplate's signature - MCPTemplateContext is compatible at runtime
    let renderFailed = false;
    const resolved = renderTemplate(templateValue, context as unknown as Record<string, unknown>, {
      onFailure: () => {
        renderFailed = true;
      },
    });

    if (renderFailed) {
      addUnresolvedField(malformedFields, fieldName);
      return undefined;
    }

    if (!resolved || resolved.trim() === '') {
      // Template resolved to empty - user probably hasn't set the var
      // Field names for env/header maps are caller-controlled and may
      // themselves contain sensitive material. Report only the closed family.
      console.log(`[mcp-template] resolution_empty field_family=${templateFieldFamily(fieldName)}`);
      return undefined;
    }

    if (hasTemplateMarker(resolved)) {
      addUnresolvedField(malformedFields, fieldName);
      console.warn(
        `[mcp-template] resolution_failed field_family=${templateFieldFamily(fieldName)} error_type=ResidualMarker`
      );
      return undefined;
    }

    return resolved;
  } catch (error) {
    // `renderTemplate` currently converts failures to an empty result, but
    // keep this fail-closed boundary value-free if that contract ever changes.
    const errorType = error instanceof Error ? 'Error' : 'UnknownError';
    console.warn(
      `[mcp-template] resolution_failed field_family=${templateFieldFamily(fieldName)} error_type=${errorType}`
    );
    addUnresolvedField(malformedFields, fieldName);
    return undefined;
  }
}

function templateFieldFamily(fieldName: string): 'url' | 'env' | 'headers' | 'auth' | 'unknown' {
  if (fieldName === 'url') return 'url';
  if (fieldName.startsWith('env.')) return 'env';
  if (fieldName.startsWith('headers.')) return 'headers';
  if (fieldName.startsWith('auth.')) return 'auth';
  return 'unknown';
}

function addUnresolvedField(fields: string[], field: string): void {
  const safeField = field.startsWith('env.')
    ? 'env.*'
    : field.startsWith('headers.')
      ? 'headers.*'
      : field;
  if (!fields.includes(safeField)) fields.push(safeField);
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
  const malformedFields: string[] = [];

  for (const [key, templateValue] of Object.entries(envTemplate)) {
    const resolved = resolveStringValue(`env.${key}`, templateValue, context, malformedFields);
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
 * - `headers.*` - Custom HTTP headers for remote transports
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
/**
 * Auth-secret fields that `resolveMcpServerTemplates` substitutes from the
 * template context. Redaction consults this set to leave `{{ }}` templates in
 * these fields intact so resolution can run.
 *
 * MUST stay in sync with the auth-secret fields `resolveMcpServerTemplates`
 * actually resolves below. Notably `oauth_access_token` / `oauth_refresh_token`
 * are OAuth-flow runtime secrets the resolver never touches, so they are
 * excluded here and always redacted.
 */
export const TEMPLATE_RESOLVABLE_MCP_AUTH_SECRET_FIELDS = [
  'token',
  'api_token',
  'api_secret',
  'oauth_client_secret',
] as const;

function isSafeResolvedHttpUrl(value: string | undefined): boolean {
  if (!value || hasTemplateMarker(value)) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

export function resolveMcpServerTemplates(
  server: MCPServer,
  context: MCPTemplateContext
): MCPTemplateResolutionResult {
  const resolved: MCPServer = { ...server };
  const unresolvedFields: string[] = [];
  const malformedFields: string[] = [];

  // Track original templated fields to detect unresolved templates
  const hadUrlTemplate = hasTemplateMarker(server.url);

  // Resolve URL (for HTTP/SSE transport)
  if (server.url) {
    resolved.url = resolveStringValue('url', server.url, context, malformedFields);
    if (hadUrlTemplate && !resolved.url) {
      addUnresolvedField(unresolvedFields, 'url');
    }
  }

  // Resolve env vars (track individual unresolved vars)
  if (server.env) {
    const resolvedEnv: Record<string, string> = {};
    for (const [key, templateValue] of Object.entries(server.env)) {
      const hadTemplate = hasTemplateMarker(templateValue);
      const resolvedValue = resolveStringValue(
        `env.${key}`,
        templateValue,
        context,
        malformedFields
      );
      if (resolvedValue !== undefined) {
        resolvedEnv[key] = resolvedValue;
      } else if (hadTemplate) {
        addUnresolvedField(unresolvedFields, `env.${key}`);
      }
    }
    resolved.env = Object.keys(resolvedEnv).length > 0 ? resolvedEnv : undefined;
  }

  // Resolve custom HTTP headers (track individual unresolved vars)
  if (server.headers) {
    const resolvedHeaders: Record<string, string> = {};
    for (const [key, templateValue] of Object.entries(server.headers)) {
      const hadTemplate = hasTemplateMarker(templateValue);
      const resolvedValue = resolveStringValue(
        `headers.${key}`,
        templateValue,
        context,
        malformedFields
      );
      if (resolvedValue !== undefined) {
        resolvedHeaders[key] = resolvedValue;
      } else if (hadTemplate) {
        addUnresolvedField(unresolvedFields, `headers.${key}`);
      }
    }
    resolved.headers = Object.keys(resolvedHeaders).length > 0 ? resolvedHeaders : undefined;
  }

  // Resolve auth fields
  if (server.auth) {
    const resolvedAuth: MCPAuth = { ...server.auth };

    if (server.auth.token) {
      const hadTemplate = hasTemplateMarker(server.auth.token);
      resolvedAuth.token = resolveStringValue(
        'auth.token',
        server.auth.token,
        context,
        malformedFields
      );
      if (hadTemplate && !resolvedAuth.token) {
        addUnresolvedField(unresolvedFields, 'auth.token');
      }
    }
    if (server.auth.api_url) {
      const hadTemplate = hasTemplateMarker(server.auth.api_url);
      resolvedAuth.api_url = resolveStringValue(
        'auth.api_url',
        server.auth.api_url,
        context,
        malformedFields
      );
      if (hadTemplate && !resolvedAuth.api_url) {
        addUnresolvedField(unresolvedFields, 'auth.api_url');
      }
    }
    if (server.auth.api_token) {
      const hadTemplate = hasTemplateMarker(server.auth.api_token);
      resolvedAuth.api_token = resolveStringValue(
        'auth.api_token',
        server.auth.api_token,
        context,
        malformedFields
      );
      if (hadTemplate && !resolvedAuth.api_token) {
        addUnresolvedField(unresolvedFields, 'auth.api_token');
      }
    }
    if (server.auth.api_secret) {
      const hadTemplate = hasTemplateMarker(server.auth.api_secret);
      resolvedAuth.api_secret = resolveStringValue(
        'auth.api_secret',
        server.auth.api_secret,
        context,
        malformedFields
      );
      if (hadTemplate && !resolvedAuth.api_secret) {
        addUnresolvedField(unresolvedFields, 'auth.api_secret');
      }
    }

    // OAuth 2.0 fields (all optional - don't default to env vars, don't track as unresolved)
    if (server.auth.type === 'oauth') {
      if (server.auth.oauth_authorization_url) {
        resolvedAuth.oauth_authorization_url = resolveStringValue(
          'auth.oauth_authorization_url',
          server.auth.oauth_authorization_url,
          context,
          malformedFields
        );
      }
      // OAuth token URL (optional - can be auto-detected)
      if (server.auth.oauth_token_url) {
        resolvedAuth.oauth_token_url = resolveStringValue(
          'auth.oauth_token_url',
          server.auth.oauth_token_url,
          context,
          malformedFields
        );
        // Don't track as unresolved - it's optional
      }

      // OAuth client ID (optional - only resolve if provided)
      if (server.auth.oauth_client_id) {
        resolvedAuth.oauth_client_id = resolveStringValue(
          'auth.oauth_client_id',
          server.auth.oauth_client_id,
          context,
          malformedFields
        );
        // Don't track as unresolved - it's optional
      }

      // OAuth client secret (optional - only resolve if provided)
      if (server.auth.oauth_client_secret) {
        resolvedAuth.oauth_client_secret = resolveStringValue(
          'auth.oauth_client_secret',
          server.auth.oauth_client_secret,
          context,
          malformedFields
        );
        // Don't track as unresolved - it's optional
      }

      // OAuth scope (optional)
      if (server.auth.oauth_scope) {
        resolvedAuth.oauth_scope = resolveStringValue(
          'auth.oauth_scope',
          server.auth.oauth_scope,
          context,
          malformedFields
        );
        // Don't track as unresolved - it's optional
      }

      // Grant type defaults to client_credentials if not provided
      resolvedAuth.oauth_grant_type = server.auth.oauth_grant_type || 'client_credentials';
    }

    resolved.auth = resolvedAuth;
  }

  // Validate after substitution at the common executor/probe boundary. A
  // stored template is only a prescription; the resolved value can still be
  // malformed, retain template syntax, switch protocol, or inject URL
  // userinfo. Never include a resolved URL in the error or logs because it may
  // contain user-provided path/query material.
  const isHttpTransport = server.transport === 'http' || server.transport === 'sse';
  const invalidFields = [...malformedFields];
  if (
    isHttpTransport &&
    ((server.url && hasTemplateMarker(server.url) && !isValidMCPHttpUrlTemplate(server.url)) ||
      !isSafeResolvedHttpUrl(resolved.url))
  ) {
    addUnresolvedField(invalidFields, 'url');
  }
  if (server.transport === 'stdio') {
    if (!resolved.command?.trim()) addUnresolvedField(invalidFields, 'command');
    if (resolved.url || resolved.headers || (resolved.auth && resolved.auth.type !== 'none')) {
      addUnresolvedField(invalidFields, 'transport configuration');
    }
  }
  for (const [field, value] of [
    ['auth.api_url', resolved.auth?.api_url],
    ['auth.oauth_authorization_url', resolved.auth?.oauth_authorization_url],
    ['auth.oauth_token_url', resolved.auth?.oauth_token_url],
  ] as const) {
    const original =
      field === 'auth.api_url'
        ? server.auth?.api_url
        : field === 'auth.oauth_authorization_url'
          ? server.auth?.oauth_authorization_url
          : server.auth?.oauth_token_url;
    if (
      value !== undefined &&
      ((original && hasTemplateMarker(original) && !isValidMCPHttpUrlTemplate(original)) ||
        !isSafeResolvedHttpUrl(value))
    ) {
      addUnresolvedField(invalidFields, field);
    }
  }

  const isValid = invalidFields.length === 0;
  let errorMessage: string | undefined;

  if (!isValid) {
    errorMessage = `MCP server configuration has invalid or unresolved ${invalidFields.join(', ')}. Use renderable templates and HTTP(S) URLs without embedded credentials, then set any required user environment variables.`;
  }

  return {
    server: resolved,
    unresolvedFields: [...new Set([...unresolvedFields, ...malformedFields])],
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
