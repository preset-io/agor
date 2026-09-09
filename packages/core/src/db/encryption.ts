import { createCipheriv, createDecipheriv, randomBytes, scrypt, scryptSync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 16;

/** Get the deployment master secret, failing closed when bootstrap regresses. */
function getMasterSecret(operation: 'encryption' | 'decryption'): string {
  const secret = process.env.AGOR_MASTER_SECRET;

  if (!secret) {
    throw new Error(`Secret ${operation} requires AGOR_MASTER_SECRET`);
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
  const masterSecret = secret ?? getMasterSecret('encryption');
  if (!masterSecret) throw new Error('Secret encryption requires AGOR_MASTER_SECRET');

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
  const masterSecret = secret ?? getMasterSecret('decryption');
  if (!masterSecret) throw new Error('Secret decryption requires AGOR_MASTER_SECRET');

  try {
    const envelope = parseEnvelope(ciphertext);
    return decryptEnvelope(envelope, deriveKey(masterSecret, envelope.salt));
  } catch {
    // Do not expose parser-vs-authentication distinctions (or OpenSSL details)
    // through API errors and logs. Operators only need to know that this field
    // cannot be opened with the active deployment key.
    throw new Error('Secret decryption failed');
  }
}

/** Same envelope and failure contract, with the expensive KDF on Node's worker pool. */
export async function decryptApiKeyAsync(ciphertext: string, secret?: string): Promise<string> {
  const masterSecret = secret ?? getMasterSecret('decryption');
  if (!masterSecret) throw new Error('Secret decryption requires AGOR_MASTER_SECRET');

  try {
    const envelope = parseEnvelope(ciphertext);
    const key = await new Promise<Buffer>((resolve, reject) => {
      scrypt(masterSecret, envelope.salt, KEY_LENGTH, (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      });
    });
    return decryptEnvelope(envelope, key);
  } catch {
    throw new Error('Secret decryption failed');
  }
}

function parseEnvelope(ciphertext: string) {
  const parts = ciphertext.split(':');
  if (parts.length !== 4) throw new Error('invalid envelope');
  const [saltHex, ivHex, authTagHex, encryptedHex] = parts;
  if (
    !isHexOfBytes(saltHex, SALT_LENGTH) ||
    !isHexOfBytes(ivHex, IV_LENGTH) ||
    !isHexOfBytes(authTagHex, 16) ||
    !isEvenHex(encryptedHex)
  ) {
    throw new Error('invalid envelope');
  }
  return {
    salt: Buffer.from(saltHex, 'hex'),
    iv: Buffer.from(ivHex, 'hex'),
    authTag: Buffer.from(authTagHex, 'hex'),
    encrypted: Buffer.from(encryptedHex, 'hex'),
  };
}

function decryptEnvelope(envelope: ReturnType<typeof parseEnvelope>, key: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, key, envelope.iv);
  decipher.setAuthTag(envelope.authTag);
  return Buffer.concat([decipher.update(envelope.encrypted), decipher.final()]).toString('utf8');
}

function isEvenHex(value: string): boolean {
  return value.length % 2 === 0 && /^[0-9a-f]*$/i.test(value);
}

function isHexOfBytes(value: string, bytes: number): boolean {
  return value.length === bytes * 2 && isEvenHex(value);
}

/**
 * Check if a string is encrypted
 */
export function isEncrypted(value: string): boolean {
  const parts = value.split(':');
  return (
    parts.length === 4 &&
    isHexOfBytes(parts[0], SALT_LENGTH) &&
    isHexOfBytes(parts[1], IV_LENGTH) &&
    isHexOfBytes(parts[2], 16) &&
    isEvenHex(parts[3])
  );
}
