import { PublicBaseUrlNotConfiguredError } from '@agor/core/config';
import { BadRequest, Conflict, Forbidden } from '@agor/core/feathers';
import { sanitizeMCPExternalError } from '@agor/core/mcp';
import { OAuthConfigurationError, OAuthDCRFailure } from '@agor/core/tools/mcp/oauth-mcp-transport';
import {
  AmbiguousRefreshError,
  GrantConfigurationChangedError,
  InvalidGrantError,
  MissingClientIdError,
  MissingRefreshTokenError,
  MissingTokenEndpointError,
  OAuthRefreshExchangeError,
} from '@agor/core/tools/mcp/oauth-refresh';
import type {
  MCPAuthRecovery,
  MCPOAuthEffectivePolicy,
  MCPOAuthFailureReason,
  MCPServerID,
} from '@agor/core/types';
import { MCPClientCredentialsConfigurationError, MCPOAuthRefreshBusyError } from './mcp-oauth-use';

function target(mcpServerId?: string) {
  return {
    ...(mcpServerId ? { mcp_server_id: mcpServerId as MCPServerID } : {}),
  };
}

type TrustedRecoveryErrorConstructor =
  | typeof MCPClientCredentialsConfigurationError
  | typeof MCPOAuthRefreshBusyError
  | typeof AmbiguousRefreshError
  | typeof InvalidGrantError
  | typeof MissingRefreshTokenError
  | typeof MissingClientIdError
  | typeof MissingTokenEndpointError
  | typeof GrantConfigurationChangedError
  | typeof OAuthRefreshExchangeError
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

const OAUTH_FAILURE_GUIDANCE: Record<MCPOAuthFailureReason, string> = {
  dcr_disabled: 'Dynamic Client Registration is explicitly disabled.',
  registration_endpoint_missing: 'No usable registration endpoint was advertised.',
  protected_resource_mismatch:
    'The protected-resource metadata does not match the saved MCP resource URL. Verify the MCP URL and provider resource metadata; no weaker policy is retried automatically.',
  issuer_mismatch:
    'The OAuth issuer does not match the expected issuer binding. Verify the provider issuer configuration and saved OAuth endpoints before reconnecting.',
  pkce_required:
    'The provider metadata does not satisfy the effective policy’s PKCE S256 requirement. Ask the provider to verify its advertised PKCE support.',
  profile_rejected:
    'The OAuth metadata does not satisfy the effective compatibility profile. Verify the provider authorization/token endpoints and callback issuer support; no weaker policy is retried automatically.',
  endpoint_override_mismatch:
    'A saved OAuth endpoint override does not match the provider metadata. Review the saved authorization and token endpoints.',
};

/**
 * Convert internal/provider failures into the closed public recovery contract.
 * Provider exception text is deliberately not inspected: even local logs are
 * not a safe destination for URLs, redirects, or reflected request values.
 */
export function classifyMCPAuthRecovery(
  error: unknown,
  options: {
    mcpServerId?: string;
    redirectUri?: string;
    oauthPolicy?: MCPOAuthEffectivePolicy;
  } = {}
): MCPAuthRecovery {
  const common = target(options.mcpServerId);

  if (safeInstanceOf(error, MCPOAuthRefreshBusyError)) {
    return {
      ...common,
      category: 'authentication_required',
      action: 'retry',
      message:
        'OAuth access changed during refresh. Retry to use the current grant; no additional refresh was attempted.',
    };
  }
  if (safeInstanceOf(error, MCPClientCredentialsConfigurationError)) {
    return {
      ...common,
      category: 'configuration_required',
      action: 'review_configuration',
      message:
        'No bound OAuth grant is available. Legacy client-credential fields alone do not establish a saved machine-token connection. For browser-capable providers, configure authorization-code OAuth and reconnect. For a client-credentials-only server, use a supported bearer credential instead; browser sign-in cannot repair it.',
    };
  }
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

  // Only configuration/provider recovery may carry policy. Permission and
  // stale-configuration failures above deliberately disclose no snapshot.
  const policy = options.oauthPolicy ? { oauth_policy: options.oauthPolicy } : {};

  if (safeInstanceOf(error, OAuthDCRFailure)) {
    const diagnostic = safeOwnDataValue(error, 'diagnostic');
    const missingEndpoint = safeOwnDataValue(diagnostic, 'stage') === 'dcr_endpoint_discovery';
    return {
      ...common,
      ...policy,
      ...(missingEndpoint ? { failure_reason: 'registration_endpoint_missing' as const } : {}),
      category: missingEndpoint ? 'client_registration_required' : 'client_registration_failed',
      action: 'configure_client',
      message: missingEndpoint
        ? 'No usable registration endpoint was advertised for this OAuth flow. Save a pre-registered Client ID (and Client Secret if required), then retry.'
        : 'The provider could not register an OAuth client automatically. Save a pre-registered Client ID (and Client Secret if required), verify the provider registration, then retry.',
      ...(options.redirectUri ? { redirect_uri: options.redirectUri } : {}),
    };
  }

  if (safeInstanceOf(error, OAuthConfigurationError)) {
    const failureCode = safeOwnDataValue(error, 'failureCode');
    const detail = safeOwnDataValue(error, 'failureReason');
    const reason: MCPOAuthFailureReason | undefined =
      failureCode === 'client_registration_required' && detail === 'dcr_disabled'
        ? 'dcr_disabled'
        : failureCode === 'metadata_incompatible'
          ? detail === 'protected_resource_mismatch'
            ? detail
            : 'profile_rejected'
          : failureCode === 'issuer_mismatch' ||
              failureCode === 'pkce_required' ||
              failureCode === 'endpoint_override_mismatch'
            ? failureCode
            : undefined;
    if (failureCode === 'client_registration_required') {
      return {
        ...common,
        ...policy,
        ...(reason ? { failure_reason: reason } : {}),
        category: 'client_registration_required',
        action: 'configure_client',
        message:
          reason === 'dcr_disabled'
            ? 'Dynamic Client Registration is explicitly disabled. Save a pre-registered Client ID (and Client Secret if required). Inspection and retry do not enable DCR.'
            : 'This OAuth configuration requires a pre-registered Client ID (and Client Secret if required). Save the client configuration, then retry.',
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
          ...policy,
          ...(reason ? { failure_reason: reason } : {}),
          category: 'metadata_incompatible',
          action: 'review_compatibility',
          message: reason
            ? OAUTH_FAILURE_GUIDANCE[reason]
            : OAUTH_FAILURE_GUIDANCE.profile_rejected,
        }
      : {
          ...common,
          ...policy,
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

  if (
    [
      AmbiguousRefreshError,
      InvalidGrantError,
      MissingRefreshTokenError,
      MissingClientIdError,
      MissingTokenEndpointError,
      GrantConfigurationChangedError,
    ].some((errorClass) => safeInstanceOf(error, errorClass))
  ) {
    return {
      ...common,
      category: 'authentication_required',
      action: 'reauthenticate',
      message:
        'The saved OAuth grant cannot be used safely. Sign in again to reconnect this server.',
    };
  }
  if (safeInstanceOf(error, OAuthRefreshExchangeError)) {
    return {
      ...common,
      category: 'authentication_required',
      action: safeOwnDataValue(error, 'ambiguous') === true ? 'reauthenticate' : 'retry',
      message:
        safeOwnDataValue(error, 'ambiguous') === true
          ? 'The provider refresh outcome is unknown. Sign in again; Agor will not replay a possibly consumed refresh token.'
          : 'The provider refused to refresh access. Retry, or review the saved OAuth client configuration.',
    };
  }

  const external = sanitizeMCPExternalError(error, { stage: 'oauth' });
  return {
    ...common,
    ...policy,
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
  if (failureCode === 'callback_issuer_mismatch' || failureCode === 'callback_issuer_missing') {
    return {
      ...common,
      category: 'metadata_incompatible',
      action: 'review_compatibility',
      failure_reason:
        failureCode === 'callback_issuer_mismatch' ? 'issuer_mismatch' : 'profile_rejected',
      message:
        failureCode === 'callback_issuer_mismatch'
          ? OAUTH_FAILURE_GUIDANCE.issuer_mismatch
          : 'The OAuth callback omitted the required issuer parameter. Ask the provider to verify callback issuer support before reconnecting.',
    };
  }
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
  if (failureCode === 'client_registration_invalidated') {
    return {
      ...common,
      category: 'authentication_required',
      action: 'reauthenticate',
      message:
        'The provider no longer recognizes this OAuth client. Reconnect to register a replacement client.',
    };
  }
  return {
    ...common,
    category: 'authentication_required',
    action: 'reauthenticate',
    message: 'Authentication did not complete. Reconnect this MCP server and try again.',
  };
}
