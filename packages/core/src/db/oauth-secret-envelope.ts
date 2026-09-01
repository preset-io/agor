import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const PREFIX = 'agor-mcp-oauth';
const FORMAT_VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

/** Purpose domains admitted by the durable bound-secret envelope. */
export type BoundSecretPurpose =
  | 'pending-exchange'
  | 'dcr-client'
  | 'codex-device-attempt'
  | 'access-token'
  | 'refresh-token'
  | 'client-id'
  | 'client-secret';

function deriveKey(masterSecret: string, salt: Buffer): Buffer {
  return scryptSync(masterSecret, salt, KEY_LENGTH);
}

function aad(purpose: BoundSecretPurpose, binding: string): Buffer {
  return Buffer.from(`${PREFIX}\0${FORMAT_VERSION}\0${purpose}\0${binding}`, 'utf8');
}

/**
 * Authenticated envelope with explicit format, purpose-domain separation, and
 * caller-supplied row binding. Unlike the legacy API-key helper this never
 * falls back to plaintext.
 *
 * The serialized v1 prefix retains its historical `agor-mcp-oauth` spelling
 * because deployed MCP grants must remain readable. Callers should depend on
 * this generic API rather than infer ownership from that compatibility prefix.
 */
export function sealBoundSecret(
  plaintext: string,
  masterSecret: string,
  purpose: BoundSecretPurpose,
  binding: string
): string {
  if (!masterSecret) throw new Error('Bound secret sealing requires AGOR_MASTER_SECRET');
  if (!binding) throw new Error('Bound secret sealing requires an AAD binding');
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

export function openBoundSecret(
  envelope: string,
  masterSecret: string,
  purpose: BoundSecretPurpose,
  binding: string
): string {
  if (!masterSecret) throw new Error('Bound secret opening requires AGOR_MASTER_SECRET');
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
    throw new Error('Unsupported bound secret envelope');
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

export function isBoundSecretEnvelope(value: string): boolean {
  return value.startsWith(`${PREFIX}:${FORMAT_VERSION}:`);
}

export const BOUND_SECRET_ENVELOPE_VERSION = 1 as const;

/** Compatibility aliases for existing MCP OAuth consumers. */
export type MCPOAuthSecretPurpose = BoundSecretPurpose;
export const sealMCPOAuthSecret = sealBoundSecret;
export const openMCPOAuthSecret = openBoundSecret;
export const isMCPOAuthSecretEnvelope = isBoundSecretEnvelope;
export const MCP_OAUTH_SECRET_ENVELOPE_VERSION = BOUND_SECRET_ENVELOPE_VERSION;
