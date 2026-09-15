/** Actual registered runtime + real Cloud/provider TLS, using an explicit test transport seam. */
import { createHash } from 'node:crypto';
import { MCPServerRepository, runWithTenantDatabaseScope } from '@agor/core/db';
import type { MCPCatalogEntry } from '@agor/core/types';
import { safeOutboundFetch } from '@agor/core/utils/safe-outbound-fetch';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type Browser,
  chromium,
} from '../../../agor-ui/src/test/managed-runtime-acceptance/browser';
import { serveBundledManagedAcceptanceUI } from '../../../agor-ui/src/test/managed-runtime-acceptance/serve-bundled-ui';
import {
  PAIRED_RUNTIME_ORIGIN,
  startManagedPairedRuntime,
} from './test-support/managed-paired-runtime';
import { startPairedCloudProcess } from './test-support/paired-cloud-fixture';

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
vi.mock('@agor/core/mcp-catalog', async (original) => ({
  ...(await original<typeof import('@agor/core/mcp-catalog')>()),
  loadCatalog: async () => catalog,
}));
let catalog: MCPCatalogEntry[] = [];
const source = process.env.AGOR_PAIRED_CLOUD_SOURCE;

describe.skipIf(process.env.AGOR_DB_DIALECT !== 'postgresql' || !source)(
  'actual paired provider browser and registered runtime',
  () => {
    let cloud: Awaited<ReturnType<typeof startPairedCloudProcess>>;
    let runtime: Awaited<ReturnType<typeof startManagedPairedRuntime>>;
    let ui: Awaited<ReturnType<typeof serveBundledManagedAcceptanceUI>>;
    let browser: Browser;
    beforeAll(async () => {
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
          return await reconcile(...args);
        } catch (error) {
          runtime.observations.push({
            path: 'reconcile',
            outcome:
              error instanceof Error
                ? `${error.name} ${error.stack?.split('\n').slice(1, 5).join(' ')}`
                : 'unknown',
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
      vi.unstubAllEnvs();
    }, 60000);
    it('uses real Catalog UI and durable runtime authority for both fake providers', async () => {
      for (const entry of catalog) {
        const readiness = await runtime.read('mcp-catalog/readiness', entry.name);
        expect(readiness.managed_oauth?.available).toBe(true);
      }
      const context = await browser.newContext();
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
        await page.goto(runtime.seed.loginUrl);
        await page.getByText('Test Cloud session ready', { exact: true }).waitFor();
        await page.goto(PAIRED_RUNTIME_ORIGIN);
        for (const entry of catalog) {
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
          await popup
            .getByRole('button', { name: /^Authorize (alpha|beta) test account$/ })
            .click();
          await popup.getByRole('link', { name: 'Return to workspace', exact: true }).click();
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
                row.catalog_entry_name === entry.name && row.owner_user_id === runtime.user.user_id
            )
          ).toBe(true);
          await popup.close();
          await page.getByRole('button', { name: 'Keep browsing', exact: true }).click();
          const server = saved.find(
            (row) =>
              row.catalog_entry_name === entry.name && row.owner_user_id === runtime.user.user_id
          )!;
          const request = { mcp_server_id: server.mcp_server_id };
          // Populate the durable invalidation checkpoint through the actual authenticated worker.
          await runtime.maintenance!.runOnce();
          const discovery = await runtime.call('mcp-servers/discover', request);
          expect(discovery.success, `Discovery denied: ${String(discovery.error)}`).toBe(true);
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
          expect(await runtime.call('mcp-servers/oauth-refresh', request)).toMatchObject({
            success: true,
          });
          const afterRefresh = (await cloud.call('counters')) as Record<
            string,
            { token: number; mcp: number }
          >;
          const provider = entry.name.includes('alpha') ? 'alpha' : 'beta';
          expect(afterRefresh[provider].token).toBe(beforeRefresh[provider].token + 1);
          expect((await runtime.call('mcp-servers/discover', request)).success).toBe(true);
          expect(((await cloud.call('counters')) as typeof afterRefresh)[provider].token).toBe(
            afterRefresh[provider].token
          );
          await runtime.call('mcp-servers/oauth-disconnect', request);
          await runtime.maintenance!.runOnce();
          const beforeDeniedUse = (await cloud.call('counters')) as typeof afterRefresh;
          expect((await runtime.call('mcp-servers/discover', request)).success).toBe(false);
          expect(((await cloud.call('counters')) as typeof afterRefresh)[provider].mcp).toBe(
            beforeDeniedUse[provider].mcp
          );
        }
      } finally {
        await context.close();
      }
    }, 180000);
  }
);
