import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 16;

/**
 * Get master secret from environment
 * Falls back to warning if not set (dev mode)
 */
function getMasterSecret(): string {
  const secret = process.env.AGOR_MASTER_SECRET;

  if (!secret) {
    console.warn(
      '⚠️  AGOR_MASTER_SECRET not set - API keys will be stored in plaintext. ' +
        'Set this environment variable to enable encryption.'
    );
    return '';
  }

  return secret;
}

/**
 * Derive encryption key from master secret using scrypt
 */
function deriveKey(secret: string, salt: Buffer): Buffer {
  return scryptSync(secret, salt, KEY_LENGTH);
}

/**
 * Encrypt API key using AES-256-GCM
 *
 * @param plaintext - API key to encrypt
 * @param secret - Master secret (from AGOR_MASTER_SECRET env var)
 * @returns Encrypted string in format: {salt}:{iv}:{authTag}:{encryptedData} (hex-encoded)
 */
export function encryptApiKey(plaintext: string, secret?: string): string {
  const masterSecret = secret || getMasterSecret();

  // If no master secret, return plaintext (dev mode)
  if (!masterSecret) {
    return plaintext;
  }

  // Generate random salt and IV
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);

  // Derive key from master secret
  const key = deriveKey(masterSecret, salt);

  // Create cipher
  const cipher = createCipheriv(ALGORITHM, key, iv);

  // Encrypt
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  // Get authentication tag
  const authTag = cipher.getAuthTag();

  // Return as hex-encoded string
  return [
    salt.toString('hex'),
    iv.toString('hex'),
    authTag.toString('hex'),
    encrypted.toString('hex'),
  ].join(':');
}

/**
 * Decrypt API key using AES-256-GCM
 *
 * @param ciphertext - Encrypted string in format: {salt}:{iv}:{authTag}:{encryptedData}
 * @param secret - Master secret (from AGOR_MASTER_SECRET env var)
 * @returns Decrypted API key
 */
export function decryptApiKey(ciphertext: string, secret?: string): string {
  const masterSecret = secret || getMasterSecret();

  // If no master secret and ciphertext doesn't look encrypted, return as-is (dev mode)
  if (!masterSecret && !ciphertext.includes(':')) {
    return ciphertext;
  }

  // Parse encrypted string
  const parts = ciphertext.split(':');
  if (parts.length !== 4) {
    throw new Error('Invalid encrypted data format');
  }

  const [saltHex, ivHex, authTagHex, encryptedHex] = parts;

  const salt = Buffer.from(saltHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');

  // Derive key from master secret
  const key = deriveKey(masterSecret, salt);

  // Create decipher
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  // Decrypt
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  return decrypted.toString('utf8');
}

/**
 * Check if a string is encrypted
 */
export function isEncrypted(value: string): boolean {
  const parts = value.split(':');
  return parts.length === 4 && parts.every((part) => /^[0-9a-f]+$/i.test(part));
}
