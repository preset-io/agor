import { PublicBaseUrlNotConfiguredError } from '@agor/core/config';
import { BadRequest, Conflict, Forbidden } from '@agor/core/feathers';
import { sanitizeMCPExternalError } from '@agor/core/mcp';
import { OAuthConfigurationError, OAuthDCRFailure } from '@agor/core/tools/mcp/oauth-mcp-transport';
import type { MCPAuthRecovery, MCPServerID } from '@agor/core/types';

function target(mcpServerId?: string) {
  return {
    ...(mcpServerId ? { mcp_server_id: mcpServerId as MCPServerID } : {}),
  };
}

type TrustedRecoveryErrorConstructor =
  | typeof Forbidden
  | typeof Conflict
  | typeof BadRequest
  | typeof OAuthDCRFailure
  | typeof OAuthConfigurationError
  | typeof PublicBaseUrlNotConfiguredError;

function safeInstanceOf(error: unknown, errorClass: TrustedRecoveryErrorConstructor) {
  try {
    return error instanceof errorClass;
  } catch {
    return false;
  }
}

function safeOwnDataValue(value: unknown, field: string): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Convert internal/provider failures into the closed public recovery contract.
 * Provider exception text is deliberately not inspected: even local logs are
 * not a safe destination for URLs, redirects, or reflected request values.
 */
export function classifyMCPAuthRecovery(
  error: unknown,
  options: { mcpServerId?: string; redirectUri?: string } = {}
): MCPAuthRecovery {
  const common = target(options.mcpServerId);

  if (safeInstanceOf(error, Forbidden)) {
    return {
      ...common,
      category: 'permission_changed',
      action: 'retry',
      message:
        'The MCP request authority or OAuth browser reservation changed or expired. Retry from the current signed-in session.',
    };
  }
  if (safeInstanceOf(error, Conflict)) {
    return {
      ...common,
      category: 'configuration_changed',
      action: 'save_and_retry',
      message:
        'The MCP configuration changed during this request. Reload the saved settings and retry.',
    };
  }
  if (safeInstanceOf(error, BadRequest)) {
    return {
      ...common,
      category: 'authentication_required',
      action: 'reauthenticate',
      message:
        'The OAuth browser reservation is invalid, expired, or already used. Start authentication again from the current session.',
    };
  }

  if (safeInstanceOf(error, OAuthDCRFailure)) {
    const diagnostic = safeOwnDataValue(error, 'diagnostic');
    const missingEndpoint = safeOwnDataValue(diagnostic, 'stage') === 'dcr_endpoint_discovery';
    return {
      ...common,
      category: missingEndpoint ? 'client_registration_required' : 'client_registration_failed',
      action: 'configure_client',
      message: missingEndpoint
        ? 'This provider requires a pre-registered OAuth client. Save a Client ID and Client Secret on this MCP server, then retry.'
        : 'The provider could not register an OAuth client automatically. Save a pre-registered Client ID and Client Secret on this MCP server, verify the provider registration, then retry.',
      ...(options.redirectUri ? { redirect_uri: options.redirectUri } : {}),
    };
  }

  if (safeInstanceOf(error, OAuthConfigurationError)) {
    const failureCode = safeOwnDataValue(error, 'failureCode');
    if (failureCode === 'client_registration_required') {
      return {
        ...common,
        category: 'client_registration_required',
        action: 'configure_client',
        message:
          'This provider requires a pre-registered OAuth client. Save a Client ID and Client Secret on this MCP server, then retry.',
        ...(options.redirectUri ? { redirect_uri: options.redirectUri } : {}),
      };
    }
    const incompatible = [
      'metadata_incompatible',
      'endpoint_override_mismatch',
      'issuer_mismatch',
      'pkce_required',
    ].includes(typeof failureCode === 'string' ? failureCode : '');
    return incompatible
      ? {
          ...common,
          category: 'metadata_incompatible',
          action: 'review_compatibility',
          message:
            'The provider OAuth metadata does not match this MCP server configuration. Verify the saved server URL and OAuth endpoints; use legacy compatibility only for a provider that requires it.',
        }
      : {
          ...common,
          category: 'metadata_unavailable',
          action: 'save_and_retry',
          message:
            'OAuth metadata could not be discovered. Verify the MCP URL or save explicit authorization and token endpoints on this MCP server, then retry.',
        };
  }

  if (safeInstanceOf(error, PublicBaseUrlNotConfiguredError)) {
    return {
      ...common,
      category: 'redirect_configuration_required',
      action: 'configure_redirect',
      message:
        'OAuth needs a browser-reachable Agor callback URL. Configure the deployment public URL and register the callback with the provider, then retry.',
      ...(options.redirectUri ? { redirect_uri: options.redirectUri } : {}),
    };
  }

  const external = sanitizeMCPExternalError(error, { stage: 'oauth' });
  return {
    ...common,
    category: external.category,
    action: external.action,
    message: external.message,
  };
}

/** Recovery for durable callback/attempt failure codes (never provider text). */
export function recoveryForOAuthAttemptFailure(
  failureCode: string | null | undefined,
  mcpServerId?: string
): MCPAuthRecovery | undefined {
  if (!failureCode) return undefined;
  const common = target(mcpServerId);
  if (failureCode === 'authorization_denied') {
    return {
      ...common,
      category: 'authorization_denied',
      action: 'reauthenticate',
      message: 'Authorization was not completed. Reconnect and approve access with the provider.',
    };
  }
  if (failureCode === 'server_configuration_changed' || failureCode === 'authorization_changed') {
    return {
      ...common,
      category: 'configuration_changed',
      action: 'save_and_retry',
      message:
        'The MCP configuration changed during authorization. Review the saved settings and reconnect.',
    };
  }
  if (failureCode === 'permission_changed') {
    return {
      ...common,
      category: 'permission_changed',
      action: 'contact_admin',
      message:
        'Your MCP authorization permission changed. Ask an administrator to review access, then reconnect.',
    };
  }
  return {
    ...common,
    category: 'authentication_required',
    action: 'reauthenticate',
    message: 'Authentication did not complete. Reconnect this MCP server and try again.',
  };
}
