/** Finite, content-free error categories for the Teams gateway boundary. */

export const TEAMS_GATEWAY_ERROR_CODES = [
  'invalid_activity',
  'invalid_botframework_issuer',
  'invalid_audience',
  'invalid_channel_endorsement',
  'invalid_tenant',
  'invalid_service_url',
  'bot_self_message',
  'provider_auth_failed',
  'provider_not_found',
  'provider_client_error',
  'provider_rate_limited',
  'provider_server_error',
  'provider_request_failed',
  'provider_effect_unknown',
  'provider_rejected',
  'pre_effect_failure',
  'teams_channel_disabled_or_missing',
  'teams_config_generation_or_identity_changed',
  'teams_payload_identity_mismatch',
  'teams_payload_invalid',
  'teams_gateway_service_unavailable',
  'teams_inbound_completion_fence_lost',
  'route_missing_or_disabled',
  'config_generation_changed',
  'conversation_address_missing',
  'conversation_address_stale',
  'conversation_address_invalid',
  'teams_worker_failure',
] as const;

export type TeamsGatewayErrorCode = (typeof TEAMS_GATEWAY_ERROR_CODES)[number];

function isTeamsGatewayErrorCode(value: unknown): value is TeamsGatewayErrorCode {
  return (
    typeof value === 'string' && (TEAMS_GATEWAY_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** Classify without returning provider SDK text, URLs, IDs, or credentials. */
export function teamsGatewayErrorCode(error: unknown): TeamsGatewayErrorCode {
  const record =
    error && typeof error === 'object' && !Array.isArray(error)
      ? (error as Record<string, unknown>)
      : undefined;
  const declared = record?.teamsCode ?? record?.code;
  if (isTeamsGatewayErrorCode(declared)) return declared;

  const status = record?.status ?? record?.statusCode;
  if (typeof status === 'number') {
    if (status === 401 || status === 403) return 'provider_auth_failed';
    if (status === 404) return 'provider_not_found';
    if (status === 429) return 'provider_rate_limited';
    if (status >= 400 && status < 500) return 'provider_client_error';
    if (status >= 500 && status < 600) return 'provider_server_error';
  }

  const message = error instanceof Error ? error.message : '';
  if (message === 'Teams activity is missing required identity fields') return 'invalid_activity';
  return 'provider_request_failed';
}
