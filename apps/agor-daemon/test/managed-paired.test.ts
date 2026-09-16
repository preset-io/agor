/**
 * Opt-in actual runtime/Cloud/provider browser acceptance. Requires disposable Docker PG,
 * installed Chromium, and AGOR_PAIRED_CLOUD_SOURCE pointing at the reviewed Cloud checkout.
 * From apps/agor-daemon (with AGOR_DB_DIALECT=postgresql and PLAYWRIGHT_BROWSERS_PATH):
 * pnpm exec vitest run --config vitest.managed-paired.config.ts
 * Set AGOR_PAIRED_CYCLE0_ONLY=1 for first-connect/task-hop coverage without reconnect.
 * The test registers its worker-local source loader for native dynamic imports; it changes no runtime admission behavior.
 * Transport seam: exact fixture HTTPS origins route through Cloud's generated-CA TLS RPC.
 * Sender raw bytes/JWT, worker validation, provider consent/token HTTP, runtime DB commit,
 * registered Socket.IO/REST services and actual UI are real. Clock/cohort are synthetic
 * operator evidence; the test Console shell is not production Console visual coverage.
 */
import { createHash, randomUUID } from 'node:crypto';
import { MCPServerRepository, runWithTenantDatabaseScope } from '@agor/core/db';
import {
  MCP_OAUTH_ROUTES,
  type MCPCatalogEntry,
  McpOAuthOperationResponseSchema,
} from '@agor/core/types';
import { safeOutboundFetch } from '@agor/core/utils/safe-outbound-fetch';
import { register } from 'tsx/esm/api';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type Browser,
  type BrowserContext,
  chromium,
} from '../../agor-ui/src/test/managed-runtime-acceptance/browser';
import { serveBundledManagedAcceptanceUI } from '../../agor-ui/src/test/managed-runtime-acceptance/serve-bundled-ui';
import { createPairedTaskGateway } from '../src/services/test-support/managed-paired-gateway';
import {
  PAIRED_RUNTIME_ORIGIN,
  startManagedPairedRuntime,
} from '../src/services/test-support/managed-paired-runtime';
import { startPairedCloudProcess } from '../src/services/test-support/paired-cloud-fixture';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    lstatSync: (
      path: Parameters<typeof fs.lstatSync>[0],
      options?: Parameters<typeof fs.lstatSync>[1]
    ) => {
      const stat = fs.lstatSync(path, options);
      // This sandbox's / mount is uid65534. Only this ownership observation is synthetic.
      if (String(path) === '/' && stat && stat.uid === 65534) stat.uid = 0;
      return stat;
    },
  };
});
vi.mock('@agor/core/utils/safe-outbound-fetch', () => ({ safeOutboundFetch: vi.fn() }));
vi.mock('@agor/core/mcp', async (original) => {
  const actual = await original<typeof import('@agor/core/mcp')>();
  return {
    ...actual,
    sanitizeMCPExternalError: (...args: Parameters<typeof actual.sanitizeMCPExternalError>) => {
      if (args[0] instanceof Error)
        failureFrames =
          args[0].stack
            ?.split('\n')
            .filter((line) => /^\s+at /.test(line))
            .slice(0, 5) ?? [];
      if (
        args[0] instanceof Error &&
        'code' in args[0] &&
        [
          'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX',
          'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING',
        ].includes(String(args[0].code))
      )
        failureFrames.unshift(args[0].message);
      return actual.sanitizeMCPExternalError(...args);
    },
  };
});
let failureFrames: string[] = [];

vi.mock('@agor/core/mcp-catalog', async (original) => ({
  ...(await original<typeof import('@agor/core/mcp-catalog')>()),
  loadCatalog: async () => catalog,
}));
let catalog: MCPCatalogEntry[] = [];
const source = process.env.AGOR_PAIRED_CLOUD_SOURCE;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let beforeReconcile: (() => Promise<void>) | undefined;
let afterReturnResponse: (() => Promise<void>) | undefined;

describe('actual paired provider browser and registered runtime', () => {
  let cloud: Awaited<ReturnType<typeof startPairedCloudProcess>>;
  let runtime: Awaited<ReturnType<typeof startManagedPairedRuntime>>;
  let ui: Awaited<ReturnType<typeof serveBundledManagedAcceptanceUI>>;
  let browser: Browser;
  let authenticatedState: Awaited<ReturnType<BrowserContext['storageState']>> | undefined;
  let unregisterSourceLoader: (() => void) | undefined;
  beforeAll(async () => {
    unregisterSourceLoader = register();
    vi.stubEnv('AGOR_MASTER_SECRET', 'synthetic-paired-master-only');
    cloud = await startPairedCloudProcess(source!);
    runtime = await startManagedPairedRuntime(cloud, (manifest) => {
      expect(createHash('sha256').update(manifest.catalogArtifact).digest('hex')).toBe(
        manifest.catalogDigest
      );
      expect(JSON.parse(manifest.catalogArtifact)).toEqual({
        version: 1,
        fixture_only: true,
        entries: manifest.catalogEntries,
      });
      catalog = structuredClone(manifest.catalogEntries);
      for (const profile of manifest.profiles) {
        expect(profile.catalog_digest).toBe(manifest.catalogDigest);
        expect(
          catalog.some(
            (entry) =>
              entry.name === profile.catalog_entry_name &&
              entry.remote_url === profile.exact_resource_uri &&
              entry.transport === 'streamable-http' &&
              entry.auth_type === 'oauth'
          )
        ).toBe(true);
      }
      const hosts = new Set([
        manifest.workerOrigin,
        ...manifest.profiles.map((p) => new URL(p.exact_resource_uri).origin),
      ]);
      vi.mocked(safeOutboundFetch).mockImplementation(async (url, options) => {
        const target = String(url);
        if (!hosts.has(new URL(target).origin)) throw new Error('Paired transport host denied');
        await options?.assertCurrent?.();
        const response = (await cloud.call('request', {
          url: target,
          method: options?.method ?? 'GET',
          headers: Object.fromEntries(new Headers(options?.headers).entries()),
          ...(options?.body === undefined
            ? {}
            : {
                bodyBase64: Buffer.from(
                  options.body instanceof Uint8Array ? options.body : String(options.body)
                ).toString('base64'),
              }),
        })) as { status: number; headers: Record<string, string>; bodyBase64: string };
        if (runtime && /\/(?:refresh|receipt)$/.test(new URL(target).pathname)) {
          try {
            const parsed = McpOAuthOperationResponseSchema.safeParse(
              JSON.parse(Buffer.from(response.bodyBase64, 'base64').toString('utf8'))
            );
            if (parsed.success && 'failure_code' in parsed.data)
              runtime.observations.push({
                path: 'refresh-outcome',
                outcome: `${parsed.data.status}:${parsed.data.failure_code}`,
              });
          } catch {
            /* Never log raw provider, transport or token response bodies. */
          }
        }
        if (new URL(target).pathname === MCP_OAUTH_ROUTES.return_ticket)
          await afterReturnResponse?.();
        return new Response(
          response.status === 204 ? null : Buffer.from(response.bodyBase64, 'base64'),
          {
            status: response.status,
            headers: response.headers,
          }
        );
      });
    });
    const acceptReturn = runtime.services.runtime.acceptReturn.bind(runtime.services.runtime);
    vi.spyOn(runtime.services.runtime, 'acceptReturn').mockImplementation(async (...args) => {
      try {
        return await acceptReturn(...args);
      } catch (error) {
        runtime.observations.push({
          path: 'acceptReturn',
          outcome:
            error instanceof Error
              ? `${error.name} ${error.stack?.split('\n').slice(1, 4).join(' ')}`
              : 'unknown',
        });
        throw error;
      }
    });
    const reconcile = runtime.services.runtime.reconcile.bind(runtime.services.runtime);
    vi.spyOn(runtime.services.runtime, 'reconcile').mockImplementation(async (...args) => {
      try {
        await beforeReconcile?.();
        return await reconcile(...args);
      } catch (error) {
        runtime.observations.push({
          path: 'reconcile',
          outcome: (() => {
            const parsed = McpOAuthOperationResponseSchema.safeParse(
              error && typeof error === 'object' && 'outcome' in error ? error.outcome : undefined
            );
            if (parsed.success && 'failure_code' in parsed.data)
              return `${parsed.data.status}:${parsed.data.failure_code}`;
            return error instanceof Error
              ? `${error.name} ${error.stack?.split('\n').slice(1, 5).join(' ')}`
              : 'unknown';
          })(),
        });
        throw error;
      }
    });
    ui = await serveBundledManagedAcceptanceUI({
      runtimeOrigin: runtime.origin,
      publicOrigin: PAIRED_RUNTIME_ORIGIN,
    });
    await cloud.call('setRuntimeUpstream', { origin: ui.origin });
    browser = await chromium.launch({ headless: true, args: runtime.manifest.tls.chromiumArgs });
  }, 180000);
  afterAll(async () => {
    await browser?.close();
    await ui?.close();
    await runtime?.stop();
    await cloud?.stop();
    unregisterSourceLoader?.();
    vi.unstubAllEnvs();
  }, 60000);
  it.each(['alpha', 'beta'])(
    'uses real Catalog UI and durable runtime authority for %s',
    async (providerName) => {
      for (const entry of catalog) {
        const readiness = await runtime.read('mcp-catalog/readiness', entry.name);
        expect(readiness.managed_oauth?.available).toBe(true);
      }
      const context = await browser.newContext({ storageState: authenticatedState });
      context.setDefaultTimeout(20000);
      try {
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        page.on('requestfailed', (request) =>
          pageErrors.push(
            `request failed: ${new URL(request.url()).pathname} (${request.failure()?.errorText})`
          )
        );
        if (!authenticatedState) {
          await page.goto(runtime.seed.loginUrl);
          await page.getByText('Test Cloud session ready', { exact: true }).waitFor();
          authenticatedState = await context.storageState();
        }
        await page.goto(PAIRED_RUNTIME_ORIGIN);
        for (const entry of catalog.filter(
          (item) => item.name === `test.paired.${providerName}/mcp`
        )) {
          let originalServerId: string | undefined;
          for (const cycle of process.env.AGOR_PAIRED_CYCLE0_ONLY === '1' ? [0] : [0, 1]) {
            await page
              .getByText(entry.title!, { exact: true })
              .first()
              .click()
              .catch(async () => {
                throw new Error(
                  `Catalog failed to mount: ${pageErrors.join('; ')} | ${(await page.locator('body').innerText()).slice(0, 1800)} | document: ${(await page.content()).slice(0, 1200)}`
                );
              });
            await page
              .getByRole('checkbox', { name: 'Use Agor-managed sign-in', exact: true })
              .check()
              .catch(async () => {
                throw new Error(
                  `Managed choice unavailable: ${(await page.locator('body').innerText()).slice(0, 2400)}`
                );
              });
            await page
              .getByRole('checkbox', {
                name: 'I understand what this server can access',
                exact: true,
              })
              .check();
            const popupPromise = page.waitForEvent('popup');
            await page.getByRole('button', { name: 'Connect', exact: true }).click();
            const popup = await popupPromise;
            await popup
              .getByRole('button', { name: 'Continue to provider', exact: true })
              .click()
              .catch(async () => {
                await page
                  .getByText('Connection in progress.', { exact: true })
                  .waitFor({ state: 'hidden', timeout: 5000 })
                  .catch(() => undefined);
                throw new Error(
                  `Managed start failed ${JSON.stringify(runtime.observations.slice(-8))}: ${(await page.locator('body').innerText()).slice(0, 2400)}`
                );
              });
            // Deterministically run the real 30s maintenance owner after prepare, before consent.
            await runtime.maintenance!.runOnce();
            const pause = entry.name.includes('alpha')
              ? {
                  reconcile: deferred(),
                  returned: deferred(),
                  consumed: deferred(),
                }
              : undefined;
            if (pause) {
              beforeReconcile = () => pause.reconcile.promise;
              afterReturnResponse = async () => {
                pause.consumed.resolve();
                await pause.returned.promise;
              };
            }
            try {
              await popup
                .getByRole('button', { name: /^Authorize (alpha|beta) test account$/ })
                .click();
              if (!pause) {
                // Beta redeems its original ticket only AFTER the real original grant committed.
                await page
                  .getByText('Connection status: Connected and ready.', { exact: true })
                  .waitFor()
                  .catch(async () => {
                    throw new Error(
                      `Commit did not become ready (${entry.name}, cycle ${cycle}): ${JSON.stringify(runtime.observations.slice(-12))} | ${(await page.locator('body').innerText()).slice(0, 2000)}`
                    );
                  });
              }
              await popup.getByRole('link', { name: 'Return to workspace', exact: true }).click();
              if (pause) {
                // Alpha's worker consumed the ticket, but its response is held across parent commit.
                await pause.consumed.promise;
                beforeReconcile = undefined;
                pause.reconcile.resolve();
                await page
                  .getByText('Connection status: Connected and ready.', { exact: true })
                  .waitFor()
                  .catch(async () => {
                    throw new Error(
                      `Commit did not become ready (${entry.name}, cycle ${cycle}): ${JSON.stringify(runtime.observations.slice(-12))} | ${(await page.locator('body').innerText()).slice(0, 2000)}`
                    );
                  });
                expect(await popup.getByText('Connected', { exact: true }).count()).toBe(0);
                pause.returned.resolve();
              }
            } finally {
              beforeReconcile = undefined;
              afterReturnResponse = undefined;
              pause?.reconcile.resolve();
              pause?.returned.resolve();
            }
            const returnConnected = await popup
              .getByText('Connected', { exact: true })
              .waitFor({ timeout: 10000 })
              .then(
                () => true,
                () => false
              );
            expect
              .soft(
                returnConnected,
                `Return: ${JSON.stringify(runtime.observations.filter((item) => item.path === 'acceptReturn').slice(-2))}`
              )
              .toBe(true);
            await page
              .getByText('Connection status: Connected and ready.', { exact: true })
              .waitFor({ timeout: 10000 });
            expect(await popup.evaluate('location.hash')).toBe('');
            const saved = await runWithTenantDatabaseScope(runtime.db, runtime.tenantId, (scoped) =>
              new MCPServerRepository(scoped).findAll()
            );
            expect(
              saved.some(
                (row) =>
                  row.catalog_entry_name === entry.name &&
                  row.owner_user_id === runtime.user.user_id
              )
            ).toBe(true);
            await popup.close();
            await page.getByRole('button', { name: 'Keep browsing', exact: true }).click();
            const server = saved.find(
              (row) =>
                row.catalog_entry_name === entry.name && row.owner_user_id === runtime.user.user_id
            )!;
            if (cycle === 0) originalServerId = server.mcp_server_id;
            else expect(server.mcp_server_id).toBe(originalServerId);
            const request = { mcp_server_id: server.mcp_server_id };
            // Populate the durable invalidation checkpoint through the actual authenticated worker.
            await runtime.maintenance!.runOnce();
            const discovery = await runtime.call('mcp-servers/discover', request);
            expect
              .soft(
                discovery.success,
                `Discovery denied: ${String(discovery.error)} ${failureFrames.join(' ')}`
              )
              .toBe(true);
            if (discovery.success)
              expect(discovery.tools).toEqual(
                expect.arrayContaining([expect.objectContaining({ name: 'fake_read' })])
              );
            await expect(
              runtime.call('mcp-servers/oauth-auth-headers', {
                mcp_server_ids: [server.mcp_server_id],
              })
            ).rejects.toMatchObject({ code: 403 });
            const beforeRefresh = (await cloud.call('counters')) as Record<
              string,
              { token: number; mcp: number }
            >;
            const refreshed = await runtime.call('mcp-servers/oauth-refresh', request);
            expect(
              refreshed.success,
              `Refresh denied: ${String(refreshed.error)} ${failureFrames.join(' ')} ${JSON.stringify(runtime.observations.slice(-4))}`
            ).toBe(true);
            const afterRefresh = (await cloud.call('counters')) as Record<
              string,
              { token: number; mcp: number }
            >;
            const provider = entry.name.includes('alpha') ? 'alpha' : 'beta';
            expect(afterRefresh[provider].token).toBe(beforeRefresh[provider].token + 1);
            expect.soft((await runtime.call('mcp-servers/discover', request)).success).toBe(true);
            expect(((await cloud.call('counters')) as typeof afterRefresh)[provider].token).toBe(
              afterRefresh[provider].token
            );
            // Real task/session attachment + local capability, with unmodified production
            // managed acquisition and per-hop authority. The existing exact-host TLS seam
            // remains the only transport substitution; no executor process is claimed.
            const taskGateway = await createPairedTaskGateway(runtime, server);
            const beforeTask = (await cloud.call('counters')) as typeof afterRefresh;
            expect(await taskGateway.forward('tools/list')).toMatchObject({
              result: {
                tools: expect.arrayContaining([expect.objectContaining({ name: 'fake_read' })]),
              },
            });
            expect(await taskGateway.forward('tools/call')).toMatchObject({
              result: {
                isError: false,
                content: [{ type: 'text', text: `Synthetic ${entry.name} accepted` }],
              },
            });
            const afterTask = (await cloud.call('counters')) as typeof afterRefresh;
            expect(afterTask[provider].mcp).toBe(beforeTask[provider].mcp + 2);
            expect(afterTask[provider].token).toBe(beforeTask[provider].token);
            await expect(
              taskGateway.forward('tools/call', taskGateway.foreignCaller)
            ).rejects.toMatchObject({ code: 'principal_revoked' });
            await expect(
              taskGateway.forward('tools/call', taskGateway.foreignTask)
            ).rejects.toMatchObject({ code: 'principal_revoked' });
            const retiredGateway = await createPairedTaskGateway(runtime, server);
            await retiredGateway.retireTask();
            await expect(retiredGateway.forward('tools/call')).rejects.toMatchObject({
              code: 'principal_revoked',
            });
            expect(((await cloud.call('counters')) as typeof afterRefresh)[provider].mcp).toBe(
              afterTask[provider].mcp
            );
            await runtime.call('mcp-servers/oauth-disconnect', request);
            await runtime.maintenance!.runOnce();
            const beforeDeniedUse = (await cloud.call('counters')) as typeof afterRefresh;
            await expect(taskGateway.forward('tools/call')).rejects.toMatchObject({
              code: 'grant_changed',
            });
            expect((await runtime.call('mcp-servers/discover', request)).success).toBe(false);
            expect(((await cloud.call('counters')) as typeof afterRefresh)[provider].mcp).toBe(
              beforeDeniedUse[provider].mcp
            );
            if (cycle === 0) {
              const canceled = await runtime.call('mcp-servers/oauth-start', {
                ...request,
                client_nonce: randomUUID(),
              });
              expect(canceled.success).toBe(true);
              await runtime.call('mcp-servers/oauth-disconnect', request);
              await runtime.maintenance!.runOnce();
              const terminal = await runtime.read(
                'mcp-servers/oauth-attempt-status',
                String(canceled.attempt_id)
              );
              expect(terminal.status).toBe('failed');
              const afterCancel = (await cloud.call('counters')) as typeof afterRefresh;
              expect(afterCancel[provider].token).toBe(beforeDeniedUse[provider].token);
              expect(afterCancel[provider].mcp).toBe(beforeDeniedUse[provider].mcp);
            }
          }
        }
      } finally {
        await context.close();
      }
    },
    180000
  );
});
