import sourcePin from '../tools/mcp/__fixtures__/managed-v1/source-pin.json';
import type { AgorConfig, AgorManagedMCPOAuthSettings } from './types';

export const MANAGED_MCP_OAUTH_CONTRACT_SOURCE_SHA256 = sourcePin.source_sha256;

export const MANAGED_MCP_OAUTH_FLAGS = [
  'enabled',
  'new_starts',
  'exchange',
  'refresh',
  'use_authorization_issuance',
  'revocation',
] as const satisfies readonly (keyof AgorManagedMCPOAuthSettings)[];

export const MANAGED_MCP_OAUTH_CONFIG_KEYS = [
  ...MANAGED_MCP_OAUTH_FLAGS,
  'broker_origin',
  'worker_issuer',
  'environment',
  'region',
  'cell_id',
  'credential_id',
  'sender_key_id',
  'sender_private_key_path',
  'worker_public_keyring_path',
  'cell_evidence_path',
  'clock_health_path',
  'contract_sha256',
] as const satisfies readonly (keyof AgorManagedMCPOAuthSettings)[];

/** Syntax only. Valid configuration does not attest a compatible admitted cell cohort. */
export function validateManagedMCPOAuthConfig(
  value: AgorManagedMCPOAuthSettings | undefined
): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('managed_mcp_oauth must be an object');
  }
  for (const key of MANAGED_MCP_OAUTH_FLAGS) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      throw new Error(`managed_mcp_oauth.${key} must be boolean`);
    }
  }
  if (value.environment !== undefined && !['staging', 'production'].includes(value.environment)) {
    throw new Error('Managed MCP OAuth environment is unsupported');
  }
  if (value.region !== undefined && value.region !== 'us-west-2') {
    throw new Error('Managed MCP OAuth region is unsupported');
  }
  if (value.broker_origin !== undefined) {
    const origin = new URL(value.broker_origin);
    if (
      origin.protocol !== 'https:' ||
      origin.origin !== value.broker_origin ||
      origin.username ||
      origin.password ||
      origin.port
    ) {
      throw new Error('Managed MCP OAuth requires an exact HTTPS broker origin on port 443');
    }
  }
  if (value.worker_issuer !== undefined) {
    const issuer = new URL(value.worker_issuer);
    if (
      issuer.protocol !== 'https:' ||
      issuer.href !== value.worker_issuer ||
      issuer.username ||
      issuer.password ||
      issuer.search ||
      issuer.hash ||
      (value.broker_origin && issuer.origin !== value.broker_origin)
    )
      throw new Error('Managed MCP OAuth requires an exact worker issuer on the broker origin');
  }
  for (const key of ['cell_id', 'credential_id', 'sender_key_id'] as const) {
    const id = value[key];
    if (id !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
      throw new Error(`Invalid managed MCP OAuth ${key}`);
    }
  }
  for (const key of [
    'sender_private_key_path',
    'worker_public_keyring_path',
    'cell_evidence_path',
    'clock_health_path',
  ] as const) {
    const path = value[key];
    if (
      path !== undefined &&
      (typeof path !== 'string' ||
        !path.startsWith('/') ||
        path.split('/').some((part) => part === '..' || part === '.') ||
        [...path].some((character) => character.charCodeAt(0) < 32))
    )
      throw new Error(`Managed MCP OAuth ${key} requires an absolute deployment path`);
  }
  if (value.contract_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(value.contract_sha256)) {
    throw new Error('Managed MCP OAuth requires an exact SHA-256 contract manifest');
  }
  if (value.enabled) {
    for (const key of MANAGED_MCP_OAUTH_CONFIG_KEYS.filter(
      (key) => !(MANAGED_MCP_OAUTH_FLAGS as readonly string[]).includes(key)
    )) {
      if (!value[key]) throw new Error(`Enabled managed MCP OAuth requires ${key}`);
    }
  }
}

export function managedMCPOAuthOperationEnabled(
  config: AgorConfig,
  operation: Exclude<(typeof MANAGED_MCP_OAUTH_FLAGS)[number], 'enabled'>
): boolean {
  return config.managed_mcp_oauth?.enabled === true && config.managed_mcp_oauth[operation] === true;
}
