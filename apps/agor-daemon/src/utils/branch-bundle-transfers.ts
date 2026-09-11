import type { AgorConfig, resolveMultiTenancyConfig } from '@agor/core/config';
import {
  assertTenantWritable,
  BranchRepository,
  BranchStorageRepository,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { type BranchID, branchStorageExecutorCommandId } from '@agor/core/types';
import type { Application as ExpressApplication, Request, Response } from 'express';
import { matchesExecutorCommandRuntimeScope } from '../auth/executor-runtime-scope.js';
import type { authenticateBearerHttpRequest } from '../register-routes.js';
import { getBranchBundleStore } from './upload-staging.js';

/** Raw byte transport only. No daemon workspace path or filesystem access. */
export function registerBranchBundleTransfers(options: {
  app: Application;
  db: TenantScopeAwareDatabase;
  config: AgorConfig;
  multiTenancy: ReturnType<typeof resolveMultiTenancyConfig>;
  authenticate: typeof authenticateBearerHttpRequest;
}): void {
  const { app, db, multiTenancy, authenticate } = options;
  const handler = async (req: Request, res: Response) => {
    let stage: 'admission' | 'upload' | 'download' = 'admission';
    try {
      const bearer = req.headers.authorization;
      if (!bearer?.startsWith('Bearer ')) {
        res.status(401).end();
        return;
      }
      const params = await authenticate({
        authentication: app.service('authentication'),
        multiTenancy,
        headers: req.headers,
        token: bearer.slice(7),
      });
      const id = String(req.params.branchId) as BranchID;
      const operationId = String(req.params.operationId);
      const action = req.method === 'POST' ? 'pack' : 'restore';
      if (
        !params.tenant?.tenant_id ||
        !params.user ||
        !matchesExecutorCommandRuntimeScope(
          params,
          branchStorageExecutorCommandId(operationId, action),
          id
        )
      ) {
        res.status(403).end();
        return;
      }
      const tenantId = params.tenant.tenant_id;
      const record = await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        await assertTenantWritable(scoped, tenantId);
        // RLS-backed parent lookup precedes any provider side effect.
        if (!(await new BranchRepository(scoped).findById(id))) throw new Error('Branch not found');
        const current = await new BranchStorageRepository(scoped).get(id);
        if (
          current.operationId !== operationId ||
          current.phase !== (action === 'pack' ? 'packing' : 'restoring')
        ) {
          throw new Error('Storage operation changed');
        }
        return current;
      });
      res.setHeader('Cache-Control', 'private, no-store');
      stage = action === 'pack' ? 'upload' : 'download';
      const store = getBranchBundleStore();
      if (action === 'pack') {
        const receipt = await store.upload({ tenantId, branchId: id, operationId }, req);
        res.json(receipt);
      } else {
        if (!record.receipt) throw new Error('Bundle receipt missing');
        const body = await store.read({ tenantId, branchId: id }, record.receipt);
        res.setHeader('Content-Type', 'application/gzip');
        res.setHeader('Content-Length', record.receipt.bytes);
        res.once('close', () => body.destroy());
        body.once('error', () => res.destroy());
        body.pipe(res);
      }
    } catch (error) {
      // Provider messages may contain URLs/keys/credentials. Emit only a bounded
      // category, never the exception or its message.
      const name = error instanceof Error ? error.name : '';
      const category = ['BadRequest', 'NoSuchBucket', 'AccessDenied', 'TimeoutError'].includes(name)
        ? name
        : 'unavailable_or_unverified';
      console.warn(
        `[BranchStorage] event=bundle_transfer_failed stage=${stage} category=${category}`
      );
      if (!res.headersSent)
        res
          .status(stage === 'admission' ? 409 : 502)
          .json({ error: 'Workspace bundle transfer unavailable' });
      else res.destroy();
    }
  };
  const http = app as unknown as ExpressApplication;
  http.post('/executor/branch-bundles/:branchId/:operationId', handler);
  http.get('/executor/branch-bundles/:branchId/:operationId', handler);
}
