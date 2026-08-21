import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const PREFIX = 'agor-mcp-oauth';
const FORMAT_VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

export type MCPOAuthSecretPurpose =
  | 'pending-exchange'
  | 'codex-device-attempt'
  | 'access-token'
  | 'refresh-token'
  | 'client-id'
  | 'client-secret';

function deriveKey(masterSecret: string, salt: Buffer): Buffer {
  return scryptSync(masterSecret, salt, KEY_LENGTH);
}

function aad(purpose: MCPOAuthSecretPurpose, binding: string): Buffer {
  return Buffer.from(`${PREFIX}\0${FORMAT_VERSION}\0${purpose}\0${binding}`, 'utf8');
}

/**
 * OAuth-only authenticated envelope with explicit format, purpose domain
 * separation, and caller-supplied row binding. Unlike the legacy API-key
 * helper this never falls back to plaintext.
 */
export function sealMCPOAuthSecret(
  plaintext: string,
  masterSecret: string,
  purpose: MCPOAuthSecretPurpose,
  binding: string
): string {
  if (!masterSecret) throw new Error('MCP OAuth secret sealing requires AGOR_MASTER_SECRET');
  if (!binding) throw new Error('MCP OAuth secret sealing requires an AAD binding');
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, deriveKey(masterSecret, salt), iv);
  cipher.setAAD(aad(purpose, binding));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    PREFIX,
    FORMAT_VERSION,
    purpose,
    salt.toString('base64url'),
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
}

export function openMCPOAuthSecret(
  envelope: string,
  masterSecret: string,
  purpose: MCPOAuthSecretPurpose,
  binding: string
): string {
  if (!masterSecret) throw new Error('MCP OAuth secret opening requires AGOR_MASTER_SECRET');
  const [prefix, version, storedPurpose, salt, iv, tag, encrypted, ...extra] = envelope.split(':');
  if (
    prefix !== PREFIX ||
    version !== FORMAT_VERSION ||
    storedPurpose !== purpose ||
    !salt ||
    !iv ||
    !tag ||
    encrypted === undefined ||
    extra.length > 0
  ) {
    throw new Error('Unsupported MCP OAuth secret envelope');
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    deriveKey(masterSecret, Buffer.from(salt, 'base64url')),
    Buffer.from(iv, 'base64url')
  );
  decipher.setAAD(aad(purpose, binding));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function isMCPOAuthSecretEnvelope(value: string): boolean {
  return value.startsWith(`${PREFIX}:${FORMAT_VERSION}:`);
}

export const MCP_OAUTH_SECRET_ENVELOPE_VERSION = 1 as const;
