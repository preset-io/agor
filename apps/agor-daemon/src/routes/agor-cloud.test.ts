import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppVariableRepository } from '@agor/core/db';
import { AGOR_CLOUD, type AgorCloudTransfer, type TenantID, type User } from '@agor/core/types';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { createPackFixture, type PackFixture } from '../../test/agor-pack-fixture';
import type { RegisterHooksContext } from '../register-hooks';
import { AgorCloudLinkService } from '../services/agor-cloud-link';
import { resetAgorCloudTransfersForTests } from '../services/agor-cloud-transfer';
import { resetUploadStagingStoreForTests } from '../utils/upload-staging';

vi.mock('../utils/spawn-executor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/spawn-executor')>()),
  requestExecutor: vi.fn(),
  spawnExecutor: vi.fn(),
  spawnExecutorFireAndForget: vi.fn(),
}));
vi.mock('../services/agor-pack-executor', async (importOriginal) =>
  (await import('../../test/agor-pack-executor-mock')).packExecutorMock(importOriginal as never)
);

const TENANT = 'cloud-link-test' as TenantID;
const CONFIG = {
  database: { dialect: 'sqlite' },
  execution: {},
  multi_tenancy: { mode: 'static', static_tenant_id: TENANT },
  agor_cloud: { console_url: 'https://console.example.test/' },
} as RegisterHooksContext['config'];
/** The fake Cloud workspace: `/auth/launch` is faked, the rest is the fixture daemon. */
const WORKSPACE = 'https://acme.dp-us1a.agor.cloud';
const RETURN_TO = 'https://agor.example.test/ui/settings/move-to-cloud';

let uploadsRoot = '';
const realFetch = globalThis.fetch;
const cloud: {
  launches: number;
  refreshes: number;
  failUploads: number;
  uploads: number;
  token: string;
  /** Runs first for every workspace request; a Response short-circuits it. */
  hook?: (pathname: string, init?: RequestInit) => Promise<Response | undefined>;
} = { launches: 0, refreshes: 0, failUploads: 0, uploads: 0, token: '' };

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeCloud(fx: PackFixture, cloudUser: User) {
  cloud.token = fx.server.headers(cloudUser.user_id as never).authorization.slice(7);
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://')) return realFetch(input, init);
    const { origin, pathname, search } = new URL(url);
    if (origin !== WORKSPACE) throw new TypeError(`fetch failed: ${origin} is not the workspace`);
    const hooked = await cloud.hook?.(pathname, init);
    if (hooked) return hooked;
    if (pathname === '/auth/launch') {
      cloud.launches++;
      const { launch_code } = JSON.parse(String(init?.body));
      return launch_code === 'launch_ok'
        ? reply(201, {
            accessToken: cloud.token,
            refreshToken: 'refresh-1',
            user: { user_id: cloudUser.user_id, email: cloudUser.email },
          })
        : reply(401, { message: 'Launch code rejected' });
    }
    if (pathname === '/authentication/refresh') {
      cloud.refreshes++;
      return reply(201, { accessToken: cloud.token, refreshToken: 'refresh-2' });
    }
    if (pathname === '/agor-pack/uploads') {
      cloud.uploads++;
      if (cloud.failUploads > 0) {
        cloud.failUploads--;
        await new Response(init?.body as never).arrayBuffer();
        return reply(503, { error: 'Service unavailable' });
      }
    }
    return realFetch(`${fx.server.url}${pathname}${search}`, init);
  });
}

beforeEach(async () => {
  uploadsRoot = await mkdtemp(join(tmpdir(), 'agor-cloud-link-'));
  vi.stubEnv('AGOR_MASTER_SECRET', 'agor-cloud-link-test-master-secret');
  Object.assign(cloud, { launches: 0, refreshes: 0, failUploads: 0, uploads: 0, hook: undefined });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetAgorCloudTransfersForTests();
  resetUploadStagingStoreForTests();
  await rm(uploadsRoot, { recursive: true, force: true });
});

async function withFixture(
  raw: Parameters<typeof createPackFixture>[0]['raw'],
  work: (fx: PackFixture) => Promise<void>
) {
  const fx = await createPackFixture({ raw, tenant: TENANT, config: CONFIG, uploadsRoot });
  fakeCloud(fx, fx.bea);
  try {
    await work(fx);
  } finally {
    await fx.close();
  }
}

function client(fx: PackFixture, user: User) {
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await realFetch(`${fx.server.url}${path}`, {
      method,
      headers: fx.server.headers(user.user_id as never),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as never };
  };
  return {
    call,
    async start() {
      const { status, body } = await call('POST', '/agor-pack/cloud/link/start', {
        return_to: RETURN_TO,
      });
      expect(status).toBe(201);
      return new URL((body as { authorize_url: string }).authorize_url).searchParams.get(
        'state'
      ) as string;
    },
    complete(state: string, overrides: Record<string, string> = {}) {
      return call('POST', '/agor-pack/cloud/link/complete', {
        state,
        launch_code: 'launch_ok',
        workspace_url: WORKSPACE,
        workspace_display_name: 'Acme',
        team_slug: 'acme',
        ...overrides,
      });
    },
  };
}

dbTest('sign-in issues a console URL and seals the workspace session server-side', async ({ db }) =>
  withFixture(db, async (fx) => {
    const ada = client(fx, fx.ada);
    const started = await ada.call('POST', '/agor-pack/cloud/link/start', { return_to: RETURN_TO });
    const url = new URL((started.body as { authorize_url: string }).authorize_url);
    expect(`${url.origin}${url.pathname}`).toBe(
      `https://console.example.test${AGOR_CLOUD.connectPath}`
    );
    expect(url.searchParams.get('return_to')).toBe(RETURN_TO);
    expect(url.searchParams.get('source')).toBe('agor.example.test');

    const done = await ada.complete(url.searchParams.get('state') as string);
    expect(done.status).toBe(201);
    expect(done.body).toEqual({
      console_url: 'https://console.example.test',
      link: {
        workspace_url: WORKSPACE,
        workspace_display_name: 'Acme',
        team_slug: 'acme',
        cloud_email: fx.bea.email,
        linked_at: expect.any(String),
      },
    });
    // Status never carries tokens; the record at rest is encrypted.
    const status = await ada.call('GET', '/agor-pack/cloud/link');
    expect(JSON.stringify(status.body)).not.toContain(cloud.token);
    expect(JSON.stringify(status.body)).not.toContain('refresh-1');
    const row = await fx.unit(() =>
      new AppVariableRepository(fx.db).find(AGOR_CLOUD.linkNamespace, fx.ada.user_id)
    );
    expect(row?.is_encrypted).toBe(true);
    expect(row?.value_text).toBeNull();
    expect(row?.value_encrypted).not.toContain('refresh-1');
    // Someone else has no link.
    expect((await client(fx, fx.bea).call('GET', '/agor-pack/cloud/link')).body).toMatchObject({
      link: null,
    });

    expect((await ada.call('DELETE', '/agor-pack/cloud/link')).body).toMatchObject({ link: null });
    expect(
      await fx.unit(() =>
        new AppVariableRepository(fx.db).find(AGOR_CLOUD.linkNamespace, fx.ada.user_id)
      )
    ).toBeNull();
  })
);

dbTest('start only accepts https (or loopback http) return URLs', async ({ db }) =>
  withFixture(db, async (fx) => {
    const ada = client(fx, fx.ada);
    for (const return_to of [
      'http://agor.example.test/ui',
      'https://user:pw@agor.example.test/ui',
      'https://agor.example.test/ui#x',
      'javascript:alert(1)',
    ]) {
      expect((await ada.call('POST', '/agor-pack/cloud/link/start', { return_to })).status).toBe(
        400
      );
    }
    expect(
      (
        await ada.call('POST', '/agor-pack/cloud/link/start', {
          return_to: 'http://localhost:5173/ui',
        })
      ).status
    ).toBe(201);
  })
);

dbTest('complete refuses a state that does not match (and spends the real one)', async ({ db }) =>
  withFixture(db, async (fx) => {
    const ada = client(fx, fx.ada);
    const state = await ada.start();
    expect((await ada.complete('not-the-state')).status).toBe(400);
    expect((await ada.complete(state)).status).toBe(400);
    // Another user's state is not this user's either.
    const beaState = await client(fx, fx.bea).start();
    expect((await ada.complete(beaState)).status).toBe(400);
    expect(cloud.launches).toBe(0);
  })
);

dbTest('complete refuses a workspace outside the configured Cloud hosts', async ({ db }) =>
  withFixture(db, async (fx) => {
    const ada = client(fx, fx.ada);
    for (const workspace_url of [
      'https://acme.agor.cloud.evil.example',
      'http://acme.dp-us1a.agor.cloud',
      'https://evilagor.cloud',
    ]) {
      expect((await ada.complete(await ada.start(), { workspace_url })).status).toBe(400);
    }
    expect(cloud.launches).toBe(0);
  })
);

dbTest('a returned sign-in cannot be replayed', async ({ db }) =>
  withFixture(db, async (fx) => {
    const ada = client(fx, fx.ada);
    const state = await ada.start();
    expect((await ada.complete(state)).status).toBe(201);
    expect((await ada.complete(state)).status).toBe(400);
    expect(cloud.launches).toBe(1);
  })
);

dbTest(
  'send streams the staged export, retries a 503, applies, and links the checklist',
  async ({ db }) =>
    withFixture(db, async (fx) => {
      const ada = client(fx, fx.ada);
      expect((await ada.complete(await ada.start())).status).toBe(201);
      const exported = await ada.call('POST', '/agor-pack/exports', {
        branch_ids: [fx.seeded.branch.branch_id],
        sections: ['board', 'schedules'],
        sessions: 'none',
        include_others_sessions: false,
      });
      const { export_id, ref, size } = exported.body as {
        export_id: string;
        ref: string;
        size: number;
      };
      // Bea cannot send Ada's export.
      expect(
        (await client(fx, fx.bea).call('POST', '/agor-pack/cloud/transfers', { export_id, ref }))
          .status
      ).toBeGreaterThanOrEqual(400);

      cloud.failUploads = 1;
      const started = await ada.call('POST', '/agor-pack/cloud/transfers', { export_id, ref });
      expect(started.status).toBe(201);
      const id = (started.body as AgorCloudTransfer).transfer_id;
      const poll = async (until: (t: AgorCloudTransfer) => boolean) => {
        for (let i = 0; i < 100; i++) {
          const { body } = await ada.call('GET', `/agor-pack/cloud/transfers/${id}`);
          if (until(body)) return body as AgorCloudTransfer;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error('transfer did not finish');
      };
      const staged = await poll((t) => t.status !== 'uploading');
      expect(staged).toMatchObject({ status: 'staged', bytes_sent: size, bytes_total: size });
      expect(cloud.uploads).toBe(2);
      // Other users never see the transfer.
      expect(
        (await client(fx, fx.bea).call('GET', `/agor-pack/cloud/transfers/${id}`)).status
      ).toBe(404);

      const applied = await ada.call('POST', `/agor-pack/cloud/transfers/${id}/apply`, {
        teammates: ['t01'],
      });
      expect(applied.status).toBe(201);
      const done = await poll((t) => t.status === 'applied' || t.status === 'failed');
      expect(done.status).toBe('applied');
      expect(done.open_url).toBe(
        `${WORKSPACE}/ui/settings/teammates?import=${done.import?.import_id}`
      );
      // The imported teammate belongs to the Cloud-side user.
      expect(done.import?.results[0]?.branch_id).toBeTruthy();
    })
);

dbTest(
  'the link refreshes an expiring session and is forgotten after a week idle',
  async ({ db }) =>
    withFixture(db, async (fx) => {
      const ada = client(fx, fx.ada);
      expect((await ada.complete(await ada.start())).status).toBe(201);
      const variables = new AppVariableRepository(fx.db);
      const edit = (change: (link: Record<string, number>) => void) =>
        fx.unit(async () => {
          const record = JSON.parse(
            (await variables.getPlain(AGOR_CLOUD.linkNamespace, fx.ada.user_id)) as string
          );
          change(record.link);
          await variables.setEncrypted(
            AGOR_CLOUD.linkNamespace,
            fx.ada.user_id,
            JSON.stringify(record)
          );
        });
      const service = new AgorCloudLinkService(fx.ctx(fx.ada));

      await edit((link) => {
        link.access_expires_at = Date.now() + 10_000;
      });
      await service.session();
      expect(cloud.refreshes).toBe(1);

      await edit((link) => {
        link.last_used_at = Date.now() - AGOR_CLOUD.linkIdleMs - 1;
      });
      expect((await service.status()).link).toBeNull();
      await expect(service.session()).rejects.toThrow('Sign in to Agor Cloud first');
    })
);

/** Export Ada's teammate on the self-hosted side; returns the staged export. */
async function stageExport(fx: PackFixture) {
  const exported = await client(fx, fx.ada).call('POST', '/agor-pack/exports', {
    branch_ids: [fx.seeded.branch.branch_id],
    sections: ['board'],
    sessions: 'none',
    include_others_sessions: false,
  });
  expect(exported.status).toBe(201);
  return exported.body as { export_id: string; ref: string };
}

async function pollTransfer(fx: PackFixture, id: string, until: (t: AgorCloudTransfer) => boolean) {
  for (let i = 0; i < 100; i++) {
    const { body } = await client(fx, fx.ada).call('GET', `/agor-pack/cloud/transfers/${id}`);
    if (until(body)) return body as AgorCloudTransfer;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('transfer did not settle');
}

dbTest('a transfer stops when the user signs in again mid-upload', async ({ db }) =>
  withFixture(db, async (fx) => {
    const ada = client(fx, fx.ada);
    expect((await ada.complete(await ada.start())).status).toBe(201);
    const { export_id, ref } = await stageExport(fx);
    cloud.hook = async (pathname, init) => {
      if (pathname !== '/agor-pack/uploads') return undefined;
      cloud.uploads++;
      await new Response(init?.body as never).arrayBuffer();
      // Relink while the first attempt is in flight, then fail it.
      if (cloud.uploads === 1) expect((await ada.complete(await ada.start())).status).toBe(201);
      return reply(503, { error: 'Service unavailable' });
    };
    const started = await ada.call('POST', '/agor-pack/cloud/transfers', { export_id, ref });
    const done = await pollTransfer(
      fx,
      (started.body as AgorCloudTransfer).transfer_id,
      (t) => t.status !== 'uploading'
    );
    expect(done).toMatchObject({
      status: 'failed',
      error: 'Cloud connection changed; start again.',
    });
    // The retry never went out under the new sign-in.
    expect(cloud.uploads).toBe(1);
  })
);

dbTest('a late refresh or sign-in never restores a disconnected link', async ({ db }) =>
  withFixture(db, async (fx) => {
    const ada = client(fx, fx.ada);
    const row = () =>
      fx.unit(() =>
        new AppVariableRepository(fx.db).find(AGOR_CLOUD.linkNamespace, fx.ada.user_id)
      );
    // Late sign-in: Disconnect lands while the launch code is being redeemed.
    const state = await ada.start();
    cloud.hook = async (pathname) => {
      if (pathname === '/auth/launch') await ada.call('DELETE', '/agor-pack/cloud/link');
      return undefined;
    };
    expect((await ada.complete(state)).status).toBe(409);
    expect(await row()).toBeNull();

    // Late refresh: Disconnect lands while the refresh is in flight.
    cloud.hook = undefined;
    expect((await ada.complete(await ada.start())).status).toBe(201);
    cloud.hook = async (pathname) => {
      if (pathname === '/authentication/refresh') await ada.call('DELETE', '/agor-pack/cloud/link');
      return undefined;
    };
    await expect(new AgorCloudLinkService(fx.ctx(fx.ada)).session({ force: true })).rejects.toThrow(
      'Sign in to Agor Cloud first'
    );
    expect(cloud.refreshes).toBe(1);
    expect(await row()).toBeNull();
  })
);

dbTest('concurrent completions of one sign-in: exactly one redeems', async ({ db }) =>
  withFixture(db, async (fx) => {
    const ada = client(fx, fx.ada);
    const state = await ada.start();
    const results = await Promise.all([
      ada.complete(state),
      ada.complete(state),
      ada.complete(state),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 400, 400]);
    expect(cloud.launches).toBe(1);
  })
);

dbTest('an applied transfer can import its remaining teammates later', async ({ db }) =>
  withFixture(db, async (fx) => {
    const ada = client(fx, fx.ada);
    expect((await ada.complete(await ada.start())).status).toBe(201);
    const { export_id, ref } = await stageExport(fx);
    // A two-teammate receipt from the workspace: t01 applied, t02 not yet.
    const receipt = (results: unknown[]) => ({
      import_id: 'imp-1',
      status: 'applied',
      content_sha256: 'a'.repeat(64),
      manifest: { teammates: [{ key: 't01' }, { key: 't02' }] },
      dry_run: [],
      results,
      error: null,
      created_at: '2026-11-05T00:00:00.000Z',
      applied_at: '2026-11-05T00:00:00.000Z',
    });
    const applied: unknown[] = [];
    cloud.hook = async (pathname, init) => {
      if (pathname === '/agor-pack/uploads') {
        await new Response(init?.body as never).arrayBuffer();
        return reply(200, receipt([{ key: 't01', branch_id: 'b-t01' }]));
      }
      if (pathname === '/agor-pack/imports/imp-1/apply') {
        applied.push(JSON.parse(String(init?.body)));
        return reply(200, receipt([{ key: 't01' }, { key: 't02' }]));
      }
      return undefined;
    };
    const started = await ada.call('POST', '/agor-pack/cloud/transfers', { export_id, ref });
    const id = (started.body as AgorCloudTransfer).transfer_id;
    expect(await pollTransfer(fx, id, (t) => t.status !== 'uploading')).toMatchObject({
      status: 'applied',
    });
    const more = await ada.call('POST', `/agor-pack/cloud/transfers/${id}/apply`, {
      teammates: ['t02'],
    });
    expect(more.status).toBe(201);
    expect(applied).toEqual([{ teammates: ['t02'], board_id: null }]);
    expect((more.body as AgorCloudTransfer).import?.results).toHaveLength(2);
  })
);

dbTest('a transient refresh failure keeps the link; a rejection forgets it', async ({ db }) =>
  withFixture(db, async (fx) => {
    const ada = client(fx, fx.ada);
    expect((await ada.complete(await ada.start())).status).toBe(201);
    const service = new AgorCloudLinkService(fx.ctx(fx.ada));
    let answer = 503;
    cloud.hook = async (pathname) =>
      pathname === '/authentication/refresh'
        ? reply(answer, { message: answer === 401 ? 'Invalid or expired refresh token' : 'busy' })
        : undefined;
    await expect(service.session({ force: true })).rejects.toThrow('is unreachable right now');
    expect((await service.status()).link).not.toBeNull();
    answer = 429;
    await expect(service.session({ force: true })).rejects.toThrow('is unreachable right now');
    expect((await service.status()).link).not.toBeNull();
    answer = 401;
    await expect(service.session({ force: true })).rejects.toThrow('sign-in expired');
    expect((await service.status()).link).toBeNull();
  })
);

// The owner rule runs before (and regardless of) the branch access check, so
// a Manager grant would not help either: the answer is 403, not the access 400.
dbTest("a member can't export a teammate they don't own", async ({ db }) =>
  withFixture(db, async (fx) => {
    const exported = await client(fx, fx.bea).call('POST', '/agor-pack/exports', {
      branch_ids: [fx.seeded.branch.branch_id],
      sections: ['board'],
      sessions: 'none',
      include_others_sessions: false,
    });
    expect(exported.status).toBe(403);
    expect(JSON.stringify(exported.body)).toContain('Only the owner');
    // The owner still can.
    expect((await stageExport(fx)).export_id).toBeTruthy();
  })
);
