import { createHash, createPrivateKey, type KeyObject, randomUUID } from 'node:crypto';
import { CLOUD_RUNTIME_SERVICE_AUDIENCE } from '@agor/core/types';
import jwt from 'jsonwebtoken';

/**
 * The Cell's runtime service credential, provisioned by Cloud through the
 * reserved `AGOR_CLOUD_*` environment (the same one trusted launchers receive).
 */
export interface CloudRuntimeCredential {
  cellId: string;
  credentialId: string;
  keyId?: string;
  privateKey: KeyObject;
}

export function sha256Hex(body: string | Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/** True when every value the credential needs is present; does not parse the key. */
export function hasCloudRuntimeCredential(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.AGOR_CLOUD_CELL_ID &&
      env.AGOR_CLOUD_RUNTIME_CREDENTIAL_ID &&
      env.AGOR_CLOUD_RUNTIME_SIGNING_KEY
  );
}

export function loadCloudRuntimeCredential(
  env: NodeJS.ProcessEnv = process.env
): CloudRuntimeCredential {
  const cellId = env.AGOR_CLOUD_CELL_ID;
  const credentialId = env.AGOR_CLOUD_RUNTIME_CREDENTIAL_ID;
  const keyId = env.AGOR_CLOUD_RUNTIME_KEY_ID || undefined;
  if (
    !cellId ||
    cellId.length > 200 ||
    !credentialId ||
    credentialId.length > 200 ||
    (keyId?.length ?? 0) > 200
  )
    throw new Error('Invalid Cloud runtime service identity');
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(env.AGOR_CLOUD_RUNTIME_SIGNING_KEY ?? '');
    if (
      privateKey.asymmetricKeyType !== 'rsa' ||
      (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    )
      throw new Error();
  } catch {
    throw new Error('Cloud runtime credential requires the Cell RS256 service key');
  }
  return { cellId, credentialId, keyId, privateKey };
}

/** One short-lived, single-use RS256 assertion bound to a scope and the exact request body. */
export function signCloudRuntimeAssertion(
  credential: CloudRuntimeCredential,
  { scope, body }: { scope: string; body: string }
): string {
  return jwt.sign(
    {
      cell_id: credential.cellId,
      credential_id: credential.credentialId,
      scope,
      body_sha256: sha256Hex(body),
    },
    credential.privateKey,
    {
      algorithm: 'RS256',
      issuer: `agor-cell:${credential.cellId}`,
      audience: CLOUD_RUNTIME_SERVICE_AUDIENCE,
      expiresIn: 60,
      jwtid: randomUUID(),
      ...(credential.keyId ? { keyid: credential.keyId } : {}),
    }
  );
}

/** Read a Cloud response body, refusing more than `maxBytes`. */
export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('Response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}
