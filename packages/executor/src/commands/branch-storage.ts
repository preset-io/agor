import { chmod, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import type { BranchBundleReceipt } from '@agor/core/types';
import type { BranchStoragePayload, ExecutorResult } from '../payload-types.js';
import { createExecutorClient } from '../services/feathers-client.js';
import { packBranchBundle, restoreBranchBundle } from './branch-bundle.js';
import { resolveExecutorBranch } from './branch-filesystem.js';
import type { CommandOptions } from './index.js';

/** Only executors touch workspace bytes. The daemon owns phase/receipt authority. */
export async function handleBranchStorage(
  payload: BranchStoragePayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) return { success: true, data: { dryRun: true } };
  const { branchId, operationId, action } = payload.params;
  const client = await createExecutorClient(
    payload.daemonUrl || 'http://localhost:3030',
    payload.sessionToken
  );
  try {
    const branch = await resolveExecutorBranch(client, branchId);
    const expectedPhase = {
      pack: 'packing',
      cleanup: 'cleanup',
      restore: 'restoring',
      publish: 'publishing',
    }[action];
    if (
      branch.workspace_storage?.operationId !== operationId ||
      branch.workspace_storage.phase !== expectedPhase
    ) {
      throw new Error('Workspace storage operation changed');
    }
    const root = branch.path;
    if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink())
      throw new Error('Workspace root is not a directory');
    const url = `${payload.daemonUrl}/executor/branch-bundles/${branchId}/${operationId}`;
    const headers = { Authorization: `Bearer ${payload.sessionToken}` };
    const control = join(root, `.agor-cold-restore-${operationId}`);
    const staging = join(control, 'workspace');
    if (action === 'pack') {
      const body = new PassThrough();
      // Admission must remain closed until both pack and HTTP have settled,
      // including an HTTP rejection during the initial Git metadata checks.
      body.on('error', () => undefined);
      const abort = new AbortController();
      const packing = packBranchBundle(root, body).catch((error) => {
        body.destroy();
        abort.abort();
        throw error;
      });
      const upload = fetch(url, {
        method: 'POST',
        headers,
        signal: abort.signal,
        body: body as never,
        duplex: 'half',
      } as Parameters<typeof fetch>[1])
        .then((response) => {
          if (response.status === 502)
            throw new Error(
              'Bundle upload could not be verified by object storage; check daemon logs'
            );
          if (!response.ok) throw new Error(`Bundle upload failed (${response.status})`);
          return response;
        })
        .catch((error) => {
          body.destroy(error instanceof Error ? error : new Error('Bundle upload failed'));
          throw error;
        });
      try {
        const [digest, response] = await Promise.all([packing, upload]);
        if (!response.ok) throw new Error(`Bundle upload failed (${response.status})`);
        const receipt = (await response.json()) as BranchBundleReceipt;
        if (receipt.sha256 !== digest.sha256 || receipt.bytes !== digest.bytes)
          throw new Error('Bundle upload digest mismatch');
        return { success: true, data: { receipt } };
      } finally {
        body.destroy();
        abort.abort();
        await Promise.allSettled([packing, upload]);
      }
    }
    if (action === 'cleanup') {
      // Keep the empty root as the existing executor mount point. Everything
      // inside it, including .git and ignored dependencies, belongs to the bundle.
      for (const name of await readdir(root))
        await rm(join(root, name), { recursive: true, force: true });
    } else if (action === 'restore') {
      if (!payload.params.digest) throw new Error('Bundle digest is required');
      if ((await readdir(root)).length && !payload.params.replacePartial)
        throw new Error('Cold workspace is not empty; recovery is required');
      await mkdir(control, { mode: 0o700 });
      const response = await fetch(url, { headers });
      if (!response.ok || !response.body)
        throw new Error(`Bundle download failed (${response.status})`);
      await restoreBranchBundle(
        Readable.fromWeb(response.body as never),
        staging,
        payload.params.digest
      );
    } else {
      const mode = (await lstat(staging)).mode & 0o7777;
      // Recovery replaces a partial old copy only AFTER the new extraction
      // has verified. The branch remains unavailable throughout publication.
      if (payload.params.replacePartial) {
        for (const name of await readdir(root)) {
          if (name !== `.agor-cold-restore-${operationId}`)
            await rm(join(root, name), { recursive: true, force: true });
        }
      }
      for (const name of await readdir(staging)) {
        if (name === `.agor-cold-restore-${operationId}`)
          throw new Error('Workspace staging name collision');
        await rename(join(staging, name), join(root, name));
      }
      await rm(control, { recursive: true });
      await chmod(root, mode);
    }
    return { success: true, data: { action } };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'BRANCH_STORAGE_FAILED',
        message: error instanceof Error ? error.message : 'Workspace storage failed',
      },
    };
  } finally {
    client.io.disconnect();
  }
}
