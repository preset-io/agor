import { openBoundSecret, sealBoundSecret } from '@agor/core/db';
import type {
  MCPSlackRecoveryNotice,
  MCPSlackRecoveryTokenClaims,
  TenantID,
} from '@agor/core/types';

export const MCP_SLACK_RECOVERY_AUDIENCE = 'agor:mcp-slack-recovery' as const;
export const MCP_SLACK_RECOVERY_ISSUER = 'agor' as const;
const MCP_SLACK_RECOVERY_ENVELOPE_BINDING = 'agor:mcp-slack-recovery:v1';

function isBoundString(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isClaims(value: unknown): value is MCPSlackRecoveryTokenClaims {
  if (!value || typeof value !== 'object') return false;
  const claims = value as Partial<MCPSlackRecoveryTokenClaims>;
  return (
    claims.type === 'mcp-slack-recovery' &&
    claims.aud === MCP_SLACK_RECOVERY_AUDIENCE &&
    claims.iss === MCP_SLACK_RECOVERY_ISSUER &&
    isBoundString(claims.tid) &&
    isBoundString(claims.sub) &&
    isBoundString(claims.credential_user_id) &&
    isBoundString(claims.slack_user_id) &&
    isBoundString(claims.slack_team_id) &&
    isBoundString(claims.gateway_channel_id) &&
    Number.isSafeInteger(claims.gateway_config_generation) &&
    claims.gateway_config_generation! >= 0 &&
    isBoundString(claims.slack_channel_id) &&
    isBoundString(claims.slack_thread_id, 2_048) &&
    isBoundString(claims.task_id) &&
    isBoundString(claims.session_id) &&
    isBoundString(claims.mcp_server_id) &&
    Number.isSafeInteger(claims.mcp_server_config_version) &&
    claims.mcp_server_config_version! >= 1 &&
    isBoundString(claims.notice_id) &&
    isBoundString(claims.jti) &&
    Number.isSafeInteger(claims.recovery_generation) &&
    claims.recovery_generation! >= 0 &&
    (claims.recovery_request_id === undefined || isBoundString(claims.recovery_request_id, 128)) &&
    Number.isSafeInteger(claims.iat) &&
    Number.isSafeInteger(claims.exp)
  );
}

export function issueMCPSlackRecoveryToken(
  input: Omit<MCPSlackRecoveryTokenClaims, 'aud' | 'iss' | 'iat' | 'exp'> & {
    expiresAt: Date;
  },
  secret: string,
  now = new Date()
): string {
  const { expiresAt, ...claims } = input;
  const iat = Math.floor(now.getTime() / 1_000);
  const exp = Math.floor(expiresAt.getTime() / 1_000);
  if (!secret || exp <= iat) throw new Error('MCP Slack recovery token lifetime is invalid');
  return sealBoundSecret(
    JSON.stringify({
      ...claims,
      iat,
      exp,
      aud: MCP_SLACK_RECOVERY_AUDIENCE,
      iss: MCP_SLACK_RECOVERY_ISSUER,
    }),
    secret,
    'slack-mcp-recovery',
    MCP_SLACK_RECOVERY_ENVELOPE_BINDING
  );
}

export function verifyMCPSlackRecoveryToken(
  token: string,
  secret: string,
  now = new Date()
): MCPSlackRecoveryTokenClaims {
  if (!isBoundString(token, 16_384)) throw new Error('MCP Slack recovery token is invalid');
  const decoded = JSON.parse(
    openBoundSecret(token, secret, 'slack-mcp-recovery', MCP_SLACK_RECOVERY_ENVELOPE_BINDING)
  ) as unknown;
  if (!isClaims(decoded)) throw new Error('MCP Slack recovery token binding is invalid');
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (decoded.exp <= nowSeconds || decoded.iat > nowSeconds + 30) {
    throw new Error('MCP Slack recovery token expired or is not yet valid');
  }
  return decoded;
}

export function mcpSlackRecoveryClaimsMatchNotice(
  claims: MCPSlackRecoveryTokenClaims,
  notice: MCPSlackRecoveryNotice,
  tenantId: TenantID | string
): boolean {
  return (
    claims.tid === tenantId &&
    claims.sub === notice.principal_user_id &&
    claims.credential_user_id === notice.credential_user_id &&
    claims.slack_user_id === notice.slack_user_id &&
    claims.slack_team_id === notice.slack_team_id &&
    claims.gateway_channel_id === notice.gateway_channel_id &&
    claims.gateway_config_generation === notice.gateway_config_generation &&
    claims.slack_channel_id === notice.slack_channel_id &&
    claims.slack_thread_id === notice.slack_thread_id &&
    claims.task_id === notice.task_id &&
    claims.session_id === notice.session_id &&
    claims.mcp_server_id === notice.mcp_server_id &&
    claims.mcp_server_config_version === notice.mcp_server_config_version &&
    claims.recovery_generation === notice.recovery_generation &&
    claims.recovery_request_id === notice.recovery_request_id &&
    claims.notice_id === notice.notice_id &&
    claims.jti === notice.token_jti &&
    claims.iat * 1_000 === new Date(notice.issued_at).getTime() &&
    claims.exp * 1_000 === new Date(notice.expires_at).getTime()
  );
}

export function mcpSlackRecoveryClaimsMatchCaller(
  claims: MCPSlackRecoveryTokenClaims,
  tenantId: string | undefined,
  userId: string | undefined
): boolean {
  return (
    !!tenantId &&
    !!userId &&
    claims.tid === tenantId &&
    claims.sub === userId &&
    claims.credential_user_id === userId
  );
}
