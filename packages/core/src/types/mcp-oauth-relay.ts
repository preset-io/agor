/** v1 wire contract shared with Cloud's packages/contracts/src/mcp-oauth-relay.ts. */
export const MCP_OAUTH_RELAY = {
  preparePath: '/api/runtime-internal/mcp-oauth/relay/prepare',
  callbackPrefix: '/api/mcp-oauth/relay/callback/',
  deliveryPath: '/api/cloud/mcp-oauth/callback',
  serviceAudience: 'agor-cloud:executor-runs',
  serviceScope: 'mcp_oauth:relay',
  callbackPurpose: 'mcp_oauth_callback',
} as const;

export interface MCPOAuthRelayPrepare {
  workspace_id: string;
  cloud_user_id: string;
  runtime_user_id: string;
  server_id: string;
  attempt_id: string;
  state: string;
  issuer: string;
  authorization_url: string;
  redirect_uri: string;
}

export interface MCPOAuthRelayCallback extends Omit<MCPOAuthRelayPrepare, 'authorization_url'> {
  code?: string;
  error?: string;
  iss?: string;
}

/** Sealed into the existing pending flow; no separate runtime relay journal. */
export interface MCPOAuthRelayBinding {
  cellId: string;
  cloudUserId: string;
}
