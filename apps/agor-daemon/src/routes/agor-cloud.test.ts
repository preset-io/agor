import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppVariableRepository } from '@agor/core/db';
import { AGOR_CLOUD, type AgorCloudMove, type TenantID, type User } from '@agor/core/types';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { createPackFixture, type PackFixture } from '../../test/agor-pack-fixture';
import type { RegisterHooksContext } from '../register-hooks';
import { AgorCloudLinkService } from '../services/agor-cloud-link';
import { resetAgorCloudMovesForTests } from '../services/agor-cloud-move';
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
  /** Chunk PUTs to answer 503 before passing them on. */
  failChunks: number;
  chunks: number;
  token: string;
  /** Runs first for every workspace request; a Response short-circuits it. */
  hook?: (pathname: string, init?: RequestInit) => Promise<Response | undefined>;
} = { launches: 0, refreshes: 0, failChunks: 0, chunks: 0, token: '' };

const isChunk = (pathname: string, init?: RequestInit) =>
  init?.method === 'PUT' && pathname.startsWith('/agor-pack/uploads/chunked/');

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
    if (isChunk(pathname, init)) {
      cloud.chunks++;
      if (cloud.failChunks > 0) {
        cloud.failChunks--;
        return reply(503, { error: 'Service unavailable' });
      }
    }
    return realFetch(`${fx.server.url}${pathname}${search}`, init);
  });
}

beforeEach(async () => {
  uploadsRoot = await mkdtemp(join(tmpdir(), 'agor-cloud-link-'));
  vi.stubEnv('AGOR_MASTER_SECRET', 'agor-cloud-link-test-master-secret');
  Object.assign(cloud, { launches: 0, refreshes: 0, failChunks: 0, chunks: 0, hook: undefined });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetAgorCloudMovesForTests();
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

/** A light move request for the seeded teammate. */
const MOVE = (fx: PackFixture) => ({
  branch_ids: [fx.seeded.branch.branch_id],
  sections: ['board', 'schedules'],
  sessions: 'none',
});

async function pollMove(fx: PackFixture, id: string, until: (m: AgorCloudMove) => boolean) {
  for (let i = 0; i < 150; i++) {
    const { body } = await client(fx, fx.ada).call('GET', `/agor-pack/cloud/moves/${id}`);
    if (until(body)) return body as AgorCloudMove;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('move did not settle');
}

dbTest(
  'a move exports, sends in resumable chunks (retrying a 503), imports, and links Finish setup',
  async ({ db }) =>
    withFixture(db, async (fx) => {
      const ada = client(fx, fx.ada);
      expect((await ada.complete(await ada.start())).status).toBe(201);
      // Bea has no link, and can't move Ada's teammate anyway.
      expect(
        (await client(fx, fx.bea).call('POST', '/agor-pack/cloud/moves', MOVE(fx))).status
      ).toBeGreaterThanOrEqual(400);

      cloud.failChunks = 1;
      const started = await ada.call('POST', '/agor-pack/cloud/moves', MOVE(fx));
      expect(started.status).toBe(201);
      const id = (started.body as AgorCloudMove).move_id;
      expect(started.body).toMatchObject({
        status: 'moving',
        workspace_url: WORKSPACE,
        workspace_display_name: 'Acme',
        items: [{ branch_id: fx.seeded.branch.branch_id, display_name: expect.any(String) }],
      });
      // One move at a time.
      expect((await ada.call('POST', '/agor-pack/cloud/moves', MOVE(fx))).status).toBe(409);
      // Other users never see the move.
      expect((await client(fx, fx.bea).call('GET', `/agor-pack/cloud/moves/${id}`)).status).toBe(
        404
      );
      expect((await client(fx, fx.bea).call('GET', '/agor-pack/cloud/moves')).body).toEqual({
        move: null,
      });

      const done = await pollMove(fx, id, (m) => m.status === 'finished');
      const [item] = done.items;
      expect(item).toMatchObject({ status: 'done', import_id: expect.any(String) });
      expect(item?.bytes_sent).toBe(item?.bytes_total);
      expect(cloud.chunks).toBe(2);
      // Through the console's launch-init, so a signed-out browser signs in first.
      const open = new URL(item?.open_url as string);
      expect(`${open.origin}${open.pathname}`).toBe(
        `https://console.example.test${AGOR_CLOUD.launchInitPath}`
      );
      expect(open.searchParams.get('return_host')).toBe(new URL(WORKSPACE).host);
      expect(open.searchParams.get('return_to')).toBe(
        `/ui/settings/import?import=${item?.import_id}`
      );
      // Reopening the modal finds it.
      expect((await ada.call('GET', '/agor-pack/cloud/moves')).body).toMatchObject({
        move: { move_id: id, status: 'finished' },
      });
      // The import happened as the Cloud-side user.
      const receipt = await client(fx, fx.bea).call('GET', `/agor-pack/imports/${item?.import_id}`);
      expect(receipt.body).toMatchObject({ status: 'applied' });
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

dbTest('a move stops when the user signs in again mid-upload', async ({ db }) =>
  withFixture(db, async (fx) => {
    const ada = client(fx, fx.ada);
    expect((await ada.complete(await ada.start())).status).toBe(201);
    cloud.hook = async (pathname, init) => {
      if (!isChunk(pathname, init)) return undefined;
      cloud.chunks++;
      // Relink while the first chunk is in flight, then fail it.
      if (cloud.chunks === 1) expect((await ada.complete(await ada.start())).status).toBe(201);
      return reply(503, { error: 'Service unavailable' });
    };
    const started = await ada.call('POST', '/agor-pack/cloud/moves', MOVE(fx));
    const done = await pollMove(
      fx,
      (started.body as AgorCloudMove).move_id,
      (m) => m.status === 'finished'
    );
    expect(done.items[0]).toMatchObject({
      status: 'failed',
      error: 'Cloud connection changed; start again.',
    });
    // The retry never went out under the new sign-in.
    expect(cloud.chunks).toBe(1);
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

dbTest('Retry resends the same file and resumes the import in the workspace', async ({ db }) =>
  withFixture(db, async (fx) => {
    const ada = client(fx, fx.ada);
    expect((await ada.complete(await ada.start())).status).toBe(201);
    let applies = 0;
    cloud.hook = async (pathname) => {
      if (!pathname.endsWith('/apply')) return undefined;
      applies++;
      return applies === 1 ? reply(500, { error: 'Pack operation failed' }) : undefined;
    };
    const started = await ada.call('POST', '/agor-pack/cloud/moves', MOVE(fx));
    const id = (started.body as AgorCloudMove).move_id;
    const failed = await pollMove(fx, id, (m) => m.status === 'finished');
    expect(failed.items[0]).toMatchObject({ status: 'failed', error: 'Pack operation failed' });
    const chunks = cloud.chunks;

    const retried = await ada.call('POST', `/agor-pack/cloud/moves/${id}/retry`, {
      branch_id: fx.seeded.branch.branch_id,
    });
    expect(retried.status).toBe(201);
    // Bea can't retry Ada's move.
    expect(
      (
        await client(fx, fx.bea).call('POST', `/agor-pack/cloud/moves/${id}/retry`, {
          branch_id: fx.seeded.branch.branch_id,
        })
      ).status
    ).toBe(404);
    const done = await pollMove(fx, id, (m) => m.status === 'finished');
    expect(done.items[0]).toMatchObject({ status: 'done', import_id: failed.items[0]?.import_id });
    // The workspace already had the file: no chunk went out again.
    expect(cloud.chunks).toBe(chunks);
    expect(applies).toBe(2);
  })
);

dbTest('Retry follows the known receipt; only a 404 from it sends the file again', async ({ db }) =>
  withFixture(db, async (fx) => {
    const ada = client(fx, fx.ada);
    expect((await ada.complete(await ada.start())).status).toBe(201);
    let applies = 0;
    let receiptReads = 0;
    let inits = 0;
    let importId = '';
    cloud.hook = async (pathname, init) => {
      if (pathname === '/agor-pack/uploads/chunked' && init?.method === 'POST') inits++;
      if (pathname.endsWith('/apply')) {
        applies++;
        return applies === 1 ? reply(500, { error: 'Pack operation failed' }) : undefined;
      }
      if (importId && pathname === `/agor-pack/imports/${importId}`) {
        receiptReads++;
        if (receiptReads === 1) return reply(503, { error: 'busy' });
        if (receiptReads === 2) return reply(404, { error: 'Import not found' });
      }
      return undefined;
    };
    const retry = (id: string) =>
      ada.call('POST', `/agor-pack/cloud/moves/${id}/retry`, {
        branch_id: fx.seeded.branch.branch_id,
      });
    const id = ((await ada.call('POST', '/agor-pack/cloud/moves', MOVE(fx))).body as AgorCloudMove)
      .move_id;
    const failed = await pollMove(fx, id, (m) => m.status === 'finished');
    importId = failed.items[0]?.import_id as string;
    expect(importId).toBeTruthy();
    expect(inits).toBe(1);

    // A transient error reading the receipt fails the try; nothing is sent again.
    await retry(id);
    const transient = await pollMove(fx, id, (m) => m.status === 'finished');
    expect(transient.items[0]).toMatchObject({ status: 'failed', error: 'busy' });
    expect(inits).toBe(1);

    // The workspace says the import doesn't exist: only then the file goes again.
    await retry(id);
    const done = await pollMove(fx, id, (m) => m.status === 'finished');
    expect(done.items[0]).toMatchObject({ status: 'done' });
    expect(inits).toBe(2);
  })
);

dbTest(
  'one move at a time per user, start and retry alike; moves follow the sign-in',
  async ({ db }) =>
    withFixture(db, async (fx) => {
      const ada = client(fx, fx.ada);
      expect((await ada.complete(await ada.start())).status).toBe(201);
      let failApply = true;
      let release: () => void = () => undefined;
      let gate: Promise<void> | null = null;
      cloud.hook = async (pathname, init) => {
        if (failApply && pathname.endsWith('/apply')) return reply(500, { error: 'nope' });
        if (gate && isChunk(pathname, init)) await gate;
        return undefined;
      };
      const old = (
        (await ada.call('POST', '/agor-pack/cloud/moves', MOVE(fx))).body as AgorCloudMove
      ).move_id;
      await pollMove(fx, old, (m) => m.status === 'finished');

      failApply = false;
      gate = new Promise((resolve) => {
        release = resolve;
      });
      const starts = await Promise.all([
        ada.call('POST', '/agor-pack/cloud/moves', MOVE(fx)),
        ada.call('POST', '/agor-pack/cloud/moves', MOVE(fx)),
      ]);
      expect(starts.map((r) => r.status).sort()).toEqual([201, 409]);
      const running = starts.find((r) => r.status === 201)?.body as AgorCloudMove;
      // Retrying the old failed move doesn't get around it either.
      expect(
        (
          await ada.call('POST', `/agor-pack/cloud/moves/${old}/retry`, {
            branch_id: fx.seeded.branch.branch_id,
          })
        ).status
      ).toBe(409);
      release();
      await pollMove(fx, running.move_id, (m) => m.status === 'finished');
      expect((await ada.call('GET', '/agor-pack/cloud/moves')).body).toMatchObject({
        move: { move_id: running.move_id },
      });
      // A new sign-in (even to the same workspace) doesn't offer the old moves.
      expect((await ada.complete(await ada.start())).status).toBe(201);
      expect((await ada.call('GET', '/agor-pack/cloud/moves')).body).toEqual({ move: null });
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
