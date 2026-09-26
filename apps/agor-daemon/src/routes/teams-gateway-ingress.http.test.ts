import { generateKeyPairSync, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import {
  BranchRepository,
  createTenantScopedDatabaseProxy,
  type Database,
  GatewayChannelRepository,
  GatewayInboundEventRepository,
  gatewayInboundEvents,
  RepoRepository,
  select,
  teamsConversationAddresses,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { BranchID, GatewayChannel, UUID } from '@agor/core/types';
import { clearJwksClients } from '@microsoft/agents-hosting';
import express from 'express';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { ownedDbTest } from '../../../../packages/core/src/db/test-helpers';
import { registerTeamsGatewayIngressRoute } from './teams-gateway-ingress';

// Only the JWKS transport is redirected. The pinned SDK, jwks-rsa key selection,
// jsonwebtoken RS256 verification, Express route, and repositories are real.
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const forgedKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = {
  app_id: 'teams-http-app',
  app_password: 'offline-test-secret',
  microsoft_tenant_id: 'teams-http-tenant',
};
const serviceUrl = 'https://smba.trafficmanager.net/teams/';
const issuer = 'https://api.botframework.com';
const nativeFetch = globalThis.fetch;

beforeEach(() => {
  clearJwksClients();
  vi.stubEnv('AGOR_MASTER_SECRET', 'teams-http-disposable-test-secret');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearJwksClients();
});

function activity(overrides: Record<string, unknown> = {}) {
  return {
    id: 'activity-1',
    type: 'message',
    channelId: 'msteams',
    serviceUrl,
    conversation: { id: 'conversation-1', conversationType: 'personal' },
    channelData: { tenant: { id: config.microsoft_tenant_id } },
    from: { id: 'human', aadObjectId: 'aad-human' },
    recipient: { id: config.app_id },
    text: 'hello',
    ...overrides,
  };
}

async function seedChannel(db: Database, extraConfig: Record<string, unknown> = {}) {
  const repo = await new RepoRepository(db).create({
    repo_id: randomUUID() as UUID,
    slug: `teams/${randomUUID()}`,
    name: 'HTTP fixture',
    repo_type: 'remote',
    remote_url: 'https://example.test/repo.git',
    local_path: '/tmp/teams-http-fixture',
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: randomUUID() as BranchID,
    repo_id: repo.repo_id as UUID,
    name: 'main',
    ref: 'refs/heads/main',
    branch_unique_id: 1,
    path: '/tmp/teams-http-fixture/main',
    created_by: 'test-user' as UUID,
  });
  return new GatewayChannelRepository(db).create({
    name: 'Teams HTTP fixture',
    created_by: 'test-user' as UUID,
    target_branch_id: branch.branch_id as UUID,
    agor_user_id: 'test-user' as UUID,
    channel_type: 'teams',
    enabled: true,
    config: { ...config, ...extraConfig },
  });
}

async function withRoute(
  db: Database,
  run: (fixture: {
    channel: GatewayChannel;
    sign: (claims?: Record<string, unknown>, forged?: boolean) => string;
    post: (
      token?: string,
      body?: Record<string, unknown>,
      channelId?: string
    ) => Promise<globalThis.Response>;
    setEndorsements: (value: string[] | undefined) => void;
    onEndorsementFetch: (callback: () => Promise<void>) => void;
  }) => Promise<void>,
  extraConfig: Record<string, unknown> = {}
) {
  const channel = await seedChannel(db, extraConfig);
  const kid = randomUUID();
  let endorsements: string[] | undefined = ['msteams'];
  let beforeEndorsement: (() => Promise<void>) | undefined;
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.get('/jwks', (_req, res) =>
    res.json({
      keys: [
        {
          ...keys.publicKey.export({ format: 'jwk' }),
          kid,
          alg: 'RS256',
          use: 'sig',
          endorsements,
        },
      ],
    })
  );
  registerTeamsGatewayIngressRoute({
    app: app as unknown as Application,
    db: createTenantScopedDatabaseProxy(db),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const redirectJwks = ((
    options: https.RequestOptions,
    callback: (response: http.IncomingMessage) => void
  ) => {
    // Unknown requests fail offline instead of accidentally contacting a provider.
    expect(['login.botframework.com', 'login.microsoftonline.com']).toContain(options.hostname);
    return http.request(`${base}/jwks`, callback);
  }) as typeof https.request;
  vi.spyOn(https, 'request').mockImplementation(redirectJwks);
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe('https://login.botframework.com/v1/.well-known/keys');
    await beforeEndorsement?.();
    return nativeFetch(`${base}/jwks`, init);
  });
  try {
    await run({
      channel,
      sign: (claims = {}, forged = false) =>
        jwt.sign(
          {
            iss: issuer,
            aud: config.app_id,
            tid: config.microsoft_tenant_id,
            serviceurl: serviceUrl,
            exp: Math.floor(Date.now() / 1000) + 3600,
            ...claims,
          },
          forged ? forgedKeys.privateKey : keys.privateKey,
          { algorithm: 'RS256', keyid: kid }
        ),
      post: (token, body = activity(), channelId = channel.id) =>
        nativeFetch(`${base}/gateway/teams/${channelId}/activities`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        }),
      setEndorsements: (value) => {
        endorsements = value;
      },
      onEndorsementFetch: (callback) => {
        beforeEndorsement = callback;
      },
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
}

async function expectNoPersistence(db: Database) {
  expect(await select(db).from(gatewayInboundEvents).all()).toHaveLength(0);
  expect(await select(db).from(teamsConversationAddresses).all()).toHaveLength(0);
}

// Every case migrates its own disposable database; leave room for loaded CI hosts.
describe('registered Teams HTTP ingress with real SDK JWT verification', {
  timeout: 60_000,
}, () => {
  ownedDbTest('commits event and encrypted address before responding 200', async ({ db }) => {
    await withRoute(db, async ({ sign, post }) => {
      const original = GatewayInboundEventRepository.prototype.admitVerifiedHttp;
      let committed!: () => void;
      const committedPromise = new Promise<void>((resolve) => {
        committed = resolve;
      });
      let release!: () => void;
      const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(GatewayInboundEventRepository.prototype, 'admitVerifiedHttp').mockImplementation(
        async function (this: GatewayInboundEventRepository, input) {
          const result = await original.call(this, input);
          committed();
          await releasePromise;
          return result;
        }
      );
      let responded = false;
      const response = post(sign()).then((result) => {
        responded = true;
        return result;
      });
      try {
        await Promise.race([
          committedPromise,
          response.then(async (result) => {
            throw new Error(`Response preceded admission: ${result.status} ${await result.text()}`);
          }),
        ]);
        const events = await select(db).from(gatewayInboundEvents).all();
        const addresses = await select(db).from(teamsConversationAddresses).all();
        expect(events).toHaveLength(1);
        expect(addresses).toHaveLength(1);
        expect(events[0].payload_encrypted).toBeTruthy();
        expect(events[0].payload_encrypted).not.toContain('hello');
        expect(addresses[0].encrypted_address).not.toContain(serviceUrl);
        expect(responded).toBe(false);
      } finally {
        release();
      }
      expect((await response).status).toBe(200);
    });
  });

  for (const failure of [
    'missing',
    'forged',
    'expired',
    'audience',
    'issuer',
    'tenant',
    'activity tenant',
    'service URL',
    'unsafe service URL',
    'endorsement',
    'missing endorsement',
  ] as const) {
    ownedDbTest(`rejects ${failure} with no event or address`, async ({ db }) => {
      await withRoute(db, async ({ sign, post, setEndorsements }) => {
        const claims: Record<string, unknown> = {};
        let body = activity();
        if (failure === 'expired') claims.exp = Math.floor(Date.now() / 1000) - 600;
        if (failure === 'audience') claims.aud = 'other-app';
        if (failure === 'issuer') claims.iss = 'https://invalid.example';
        if (failure === 'tenant') claims.tid = 'other-tenant';
        if (failure === 'activity tenant')
          body = activity({ channelData: { tenant: { id: 'other-tenant' } } });
        if (failure === 'service URL') claims.serviceurl = 'https://other.example/';
        if (failure === 'unsafe service URL') {
          claims.serviceurl = 'http://smba.trafficmanager.net/teams/';
          body = activity({ serviceUrl: claims.serviceurl });
        }
        if (failure === 'endorsement') setEndorsements(['slack']);
        if (failure === 'missing endorsement') setEndorsements(undefined);
        const result = await post(
          failure === 'missing' ? undefined : sign(claims, failure === 'forged'),
          body
        );
        expect(result.status).toBe(
          ['missing', 'forged', 'expired', 'audience', 'issuer'].includes(failure) ? 401 : 403
        );
        if (result.status === 403) {
          expect(await result.json()).toMatchObject({
            code: failure.includes('tenant')
              ? 'invalid_tenant'
              : failure.includes('endorsement')
                ? 'invalid_channel_endorsement'
                : 'invalid_service_url',
          });
        }
        await expectNoPersistence(db);
      });
    });
  }

  for (const allowlist of [
    'allowed_user_aad_object_ids',
    'allowed_team_ids',
    'allowed_channel_ids',
  ]) {
    ownedDbTest(`rejects ${allowlist} without persistence`, async ({ db }) => {
      await withRoute(
        db,
        async ({ sign, post }) => {
          expect((await post(sign())).status).toBe(403);
          await expectNoPersistence(db);
        },
        { [allowlist]: ['somebody-else'] }
      );
    });
  }

  ownedDbTest(
    'rejects a configuration-generation race after real signature verification',
    async ({ db }) => {
      await withRoute(db, async ({ channel, sign, post, onEndorsementFetch }) => {
        onEndorsementFetch(async () => {
          await new GatewayChannelRepository(db).update(channel.id, {
            config: { ...channel.config, allowed_user_aad_object_ids: ['changed-after-auth'] },
          });
        });
        const result = await post(sign());
        expect(result.status).toBe(503);
        expect(await result.json()).toEqual({ error: 'Teams activity was not durably admitted' });
        expect(
          (await new GatewayChannelRepository(db).findById(channel.id))?.provider_config_generation
        ).toBeGreaterThan(channel.provider_config_generation);
        await expectNoPersistence(db);
      });
    }
  );

  ownedDbTest(
    'deduplicates retries but admits the same activity ID in another conversation',
    async ({ db }) => {
      await withRoute(db, async ({ sign, post }) => {
        const token = sign();
        expect((await post(token)).status).toBe(200);
        expect((await post(token)).status).toBe(200);
        expect(await select(db).from(gatewayInboundEvents).all()).toHaveLength(1);
        expect(
          (
            await post(
              token,
              activity({ conversation: { id: 'conversation-2', conversationType: 'personal' } })
            )
          ).status
        ).toBe(200);
        expect(await select(db).from(gatewayInboundEvents).all()).toHaveLength(2);
        expect(await select(db).from(teamsConversationAddresses).all()).toHaveLength(2);
      });
    }
  );

  ownedDbTest(
    'uses a collision-safe conversation/activity tuple and the base channel conversation',
    async ({ db }) => {
      await withRoute(db, async ({ sign, post }) => {
        const token = sign();
        for (const [conversationId, id] of [
          ['a|b', 'c'],
          ['a', 'b|c'],
        ]) {
          expect(
            (
              await post(
                token,
                activity({ id, conversation: { id: conversationId, conversationType: 'personal' } })
              )
            ).status
          ).toBe(200);
        }
        const channelActivity = activity({
          id: 'channel-reply',
          replyToId: 'root',
          conversation: { id: 'base;messageid=root', conversationType: 'channel' },
        });
        expect((await post(token, channelActivity)).status).toBe(200);
        expect(
          (
            await post(token, {
              ...channelActivity,
              conversation: { id: 'base', conversationType: 'channel' },
            })
          ).status
        ).toBe(200);
        expect(await select(db).from(gatewayInboundEvents).all()).toHaveLength(3);
      });
    }
  );

  ownedDbTest(
    'does not let one channel exhaust another channel sharing the same source IP',
    { timeout: 60_000 },
    async ({ db }) => {
      await withRoute(db, async ({ sign, post }) => {
        for (let index = 0; index < 120; index++) expect((await post(undefined)).status).toBe(401);
        expect((await post(undefined)).status).toBe(429);
        const second = await seedChannel(db, { app_id: 'another-app' });
        expect((await post(sign({ aud: 'another-app' }), activity(), second.id)).status).toBe(200);
        expect(await select(db).from(gatewayInboundEvents).all()).toHaveLength(1);
      });
    }
  );
});
