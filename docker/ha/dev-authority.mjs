/** Disposable Compose control-plane simulation, NOT Cloud delivery/reconciliation. */
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createDevAuthority({
  directory,
  publicDirectory,
  issuer,
  endpoint,
  fetcher = fetch,
}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(publicDirectory, { recursive: true });
  const file = join(directory, 'authority.json');
  let saved;
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    saved = { ...pair, personas: {} };
  }
  function persist() {
    writeFileSync(`${file}.tmp`, JSON.stringify(saved), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  persist();
  writeFileSync(join(publicDirectory, 'public.pem'), saved.publicKey, { mode: 0o644 });
  let queue = Promise.resolve();
  return {
    // Serialize sync and mutation; persist intent before sending so failure/restart
    // retries the same revision rather than silently re-enabling the persona.
    synchronize(persona, action) {
      const work = queue.then(async () => {
        let state = saved.personas[persona.id];
        if (!state)
          state = saved.personas[persona.id] = { revision: '1', login_epoch: '1', active: true };
        if (action) {
          if (!['disable', 'enable', 'revoke'].includes(action)) throw new Error('Invalid action');
          state.revision = String(BigInt(state.revision) + 1n);
          state.login_epoch = String(BigInt(state.login_epoch) + 1n);
          if (action !== 'revoke') state.active = action === 'enable';
        }
        persist();
        const now = Math.floor(Date.now() / 1000);
        const claims = {
          iss: issuer,
          aud: 'agor-authority:ha-dev',
          purpose: 'external-authority-v1',
          cell_id: 'ha-dev',
          tenant_id: persona.tenantId,
          workspace_id: persona.tenantId,
          provider: 'agor-ha-dev-launcher',
          sub: persona.subject,
          role: persona.role,
          ...state,
          iat: now,
          exp: now + 60,
          jti: randomUUID(),
        };
        const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const input = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}`;
        const assertion = `${input}.${sign('RSA-SHA256', Buffer.from(input), saved.privateKey).toString('base64url')}`;
        const response = await fetcher(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ assertion }),
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        });
        if (!response.ok) throw new Error('Authority synchronization failed');
        const ack = await response.json();
        if (
          ack.protocol !== 1 ||
          ack.applied_revision !== state.revision ||
          ack.applied_login_epoch !== state.login_epoch ||
          !['applied', 'duplicate'].includes(ack.outcome)
        ) {
          throw new Error('Authority acknowledgment mismatch');
        }
        return { ...state };
      });
      queue = work.catch(() => {});
      return work;
    },
  };
}
