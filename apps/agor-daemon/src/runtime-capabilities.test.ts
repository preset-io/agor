import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgorConfig, loadConfigFromFile, resolveEffectiveConfig } from '@agor/core/config';
import { afterEach, expect, it } from 'vitest';
import { MCPOAuthRelay, relayBodyHash } from './services/mcp-oauth-relay';

// Cloud's image recipe reads this daemon-owned source path, not a hand-edited
// artifact flag. Keep the declaration in sync with config parsing AND runtime
// support. Cloud owns strict image stamping/probe tests; no image is built here.
const sourceDeclaration = new URL('../runtime-capabilities.json', import.meta.url);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

it('ships exactly the v1 compatibility declaration at the daemon source packaging path', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  expect(manifest.name).toBe('@agor/daemon');
  expect(JSON.parse(await readFile(sourceDeclaration, 'utf8'))).toStrictEqual({
    schemaVersion: 1,
    mcpOauthRelayConfigVersions: [1],
  });
});

it('accepts every declared config version through the real loader and relay implementation', async () => {
  const declaration = JSON.parse(await readFile(sourceDeclaration, 'utf8'));
  expect(declaration.mcpOauthRelayConfigVersions).toEqual([1]);
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const config: AgorConfig = {
    external_launch: {
      enabled: true,
      exchange_url: 'https://cloud.example.test/exchange',
      issuer: 'https://cloud.example.test',
      audience: 'agor-cell:fixture',
      public_key: key.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
    mcp_oauth_relay: {
      callback_origin: 'https://cloud.example.test',
      cell_id: 'fixture-cell',
      credential_id: 'fixture-credential',
      private_key_env: 'FIXTURE_CELL_KEY',
      key_id: 'fixture-key',
    },
  };
  const directory = await mkdtemp(join(tmpdir(), 'agor-capability-'));
  directories.push(directory);
  const path = join(directory, 'config.yaml');
  // JSON is YAML: exercise the actual startup parser, not a type assertion.
  await writeFile(path, JSON.stringify(config));
  const loaded = await loadConfigFromFile(path);
  const effective = resolveEffectiveConfig(loaded, {});
  expect(effective.mcp_oauth_relay).toStrictEqual(config.mcp_oauth_relay);
  const relay = new MCPOAuthRelay(effective, {
    FIXTURE_CELL_KEY: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  });
  expect(relay.redirectUri('https://provider.example.test')).toBe(
    `https://cloud.example.test/api/mcp-oauth/relay/callback/${relayBodyHash('https://provider.example.test')}`
  );
  // Compatibility is not a blanket parser escape hatch for future config keys.
  await writeFile(
    path,
    JSON.stringify({
      ...config,
      mcp_oauth_relay: { ...config.mcp_oauth_relay, unsupported_future_key: true },
    })
  );
  await expect(loadConfigFromFile(path)).rejects.toThrow('unsupported_future_key');
});
