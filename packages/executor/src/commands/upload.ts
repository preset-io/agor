import { mkdir, open, rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { BranchUploadMaterializePayload, ExecutorResult } from '../payload-types.js';
import { createExecutorClient } from '../services/feathers-client.js';
import { resolveExecutorBranch, resolvePathInsideBranch } from './branch-filesystem.js';
import type { CommandOptions } from './index.js';

function safeFilename(value: string): string {
  return (
    basename(value)
      .replace(/[^A-Za-z0-9._ -]/g, '_')
      .replace(/[. ]+$/g, '')
      .slice(0, 200) || 'upload'
  );
}

export function uploadMaterializationRelativePath(params: {
  sessionId: string;
  uploadRef: string;
  filename: string;
}): string {
  return `.agor/session-staging/${params.sessionId}/${params.uploadRef}/${safeFilename(params.filename)}`;
}

export async function handleBranchUploadMaterialize(
  payload: BranchUploadMaterializePayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) return { success: true, data: { dryRun: true, command: payload.command } };
  let client: Awaited<ReturnType<typeof createExecutorClient>> | null = null;
  let destination: string | undefined;
  let createdDestination = false;
  try {
    client = await createExecutorClient(
      payload.daemonUrl || 'http://localhost:3030',
      payload.sessionToken
    );
    const branch = await resolveExecutorBranch(client, payload.params.branchId);
    const relative = uploadMaterializationRelativePath(payload.params);
    const resolved = await resolvePathInsideBranch(branch.path, relative);
    destination = resolved.absolute;
    // Do not impose private modes here. Materialization runs as the requesting
    // user inside the branch, so the branch's setgid/default ACL and the
    // executor umask must remain the source of truth for collaborator access.
    await mkdir(dirname(destination), { recursive: true });
    // Re-resolve after mkdir so a concurrently introduced parent symlink
    // cannot redirect the exclusive destination write.
    const confined = await resolvePathInsideBranch(branch.path, relative);
    destination = confined.absolute;
    const response = await fetch(
      `${payload.daemonUrl || 'http://localhost:3030'}/executor/uploads/${payload.params.uploadRef}/content`,
      {
        headers: {
          Authorization: `Bearer ${payload.sessionToken}`,
          'X-Agor-Session-Id': payload.params.sessionId,
        },
      }
    );
    if (!response.ok || !response.body) {
      throw new Error(`Upload transfer failed with HTTP ${response.status}`);
    }
    // The ref-scoped destination is deterministic. A retry replaces only the
    // same upload's prior materialization, never another upload with the same name.
    await rm(destination, { force: true });
    const handle = await open(destination, 'wx');
    createdDestination = true;
    try {
      await pipeline(Readable.fromWeb(response.body as never), handle.createWriteStream());
    } finally {
      await handle.close().catch(() => undefined);
    }
    return { success: true, data: { path: confined.relative } };
  } catch (error) {
    if (destination && createdDestination)
      await rm(destination, { force: true }).catch(() => undefined);
    const permissionDenied =
      error instanceof Error &&
      'code' in error &&
      ((error as NodeJS.ErrnoException).code === 'EACCES' ||
        (error as NodeJS.ErrnoException).code === 'EPERM');
    return {
      success: false,
      error: {
        code: 'UPLOAD_MATERIALIZE_FAILED',
        message: permissionDenied
          ? 'Branch filesystem permissions denied upload materialization for the requesting user'
          : error instanceof Error
            ? error.message
            : String(error),
      },
    };
  } finally {
    client?.io.disconnect();
  }
}
