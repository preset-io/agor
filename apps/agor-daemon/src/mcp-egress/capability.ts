import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { MCPEgressGatewayMode, MCPServerID } from '@agor/core/types';

const CAPABILITY_PREFIX = 'agor_mcp_cap_v1';
const CAPABILITY_AAD = Buffer.from(`${CAPABILITY_PREFIX}:task-live`, 'utf8');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Daemon-only routing authority, never a provider credential. Claims are
 * authenticated and encrypted so the executor receives an opaque value rather
 * than another inspectable JWT. It has no wall-clock expiry because every use
 * revalidates the live Task and current durable config/grant/material versions.
 */
export interface MCPEgressCapabilityClaims {
  type: 'mcp-egress-capability';
  tid: string;
  task_id: string;
  session_id: string;
  principal_user_id: string;
  credential_user_id: string;
  mcp_server_id: MCPServerID | string;
  config_version: number;
  material_hash: string;
  /** Secret-free fingerprint distinguishing runtime tool-policy changes. */
  tool_policy_hash?: string;
  /** Keyed hash of this server's complete projected authority snapshot. */
  authority_fingerprint?: string;
  grant_identity?: string;
  rollout_mode: MCPEgressGatewayMode;
  /** Durable Task recovery fence at issuance; unrelated to provider authority. */
  recovery_generation?: number;
  recovery_request_id?: string;
  jti: string;
}

export type IssueMCPEgressCapabilityClaims = Omit<MCPEgressCapabilityClaims, 'type'>;

function capabilityKey(secret: string): Buffer {
  return createHash('sha256').update('agor:mcp-egress:capability-key:v1\0').update(secret).digest();
}

function validateClaims(value: unknown): MCPEgressCapabilityClaims {
  if (!value || typeof value !== 'object') throw new Error('Invalid MCP egress capability');
  const claims = value as MCPEgressCapabilityClaims;
  if (claims.type !== 'mcp-egress-capability') throw new Error('Invalid MCP egress capability');
  for (const item of [
    claims.tid,
    claims.task_id,
    claims.session_id,
    claims.principal_user_id,
    claims.credential_user_id,
    claims.mcp_server_id,
    claims.material_hash,
    claims.jti,
  ]) {
    if (typeof item !== 'string' || !item) throw new Error('Incomplete MCP egress capability');
  }
  if (!Number.isSafeInteger(claims.config_version) || claims.config_version < 1) {
    throw new Error('Invalid MCP config version');
  }
  if (claims.rollout_mode !== 'compatibility' && claims.rollout_mode !== 'enforced') {
    throw new Error('Invalid MCP rollout mode');
  }
  if (claims.grant_identity !== undefined && typeof claims.grant_identity !== 'string') {
    throw new Error('Invalid MCP grant identity');
  }
  if (claims.tool_policy_hash !== undefined && typeof claims.tool_policy_hash !== 'string') {
    throw new Error('Invalid MCP tool policy fingerprint');
  }
  if (
    claims.authority_fingerprint !== undefined &&
    typeof claims.authority_fingerprint !== 'string'
  ) {
    throw new Error('Invalid MCP authority fingerprint');
  }
  if (
    claims.recovery_generation !== undefined &&
    (!Number.isSafeInteger(claims.recovery_generation) || claims.recovery_generation < 0)
  ) {
    throw new Error('Invalid MCP recovery generation');
  }
  if (
    claims.recovery_request_id !== undefined &&
    (typeof claims.recovery_request_id !== 'string' || !claims.recovery_request_id)
  ) {
    throw new Error('Invalid MCP recovery request');
  }
  return claims;
}

export function issueMCPEgressCapability(
  claims: IssueMCPEgressCapabilityClaims,
  secret: string
): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', capabilityKey(secret), nonce);
  cipher.setAAD(CAPABILITY_AAD);
  const plaintext = Buffer.from(
    JSON.stringify({ ...claims, type: 'mcp-egress-capability' }),
    'utf8'
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `${CAPABILITY_PREFIX}.${Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url')}`;
}

export function verifyMCPEgressCapability(
  token: string,
  secret: string
): MCPEgressCapabilityClaims {
  const [prefix, encoded, extra] = token.split('.');
  if (prefix !== CAPABILITY_PREFIX || !encoded || extra !== undefined) {
    throw new Error('Invalid MCP egress capability');
  }
  const envelope = Buffer.from(encoded, 'base64url');
  if (envelope.byteLength <= NONCE_BYTES + TAG_BYTES) {
    throw new Error('Invalid MCP egress capability');
  }
  const nonce = envelope.subarray(0, NONCE_BYTES);
  const tag = envelope.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const ciphertext = envelope.subarray(NONCE_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', capabilityKey(secret), nonce);
  decipher.setAAD(CAPABILITY_AAD);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return validateClaims(JSON.parse(plaintext.toString('utf8')));
}
