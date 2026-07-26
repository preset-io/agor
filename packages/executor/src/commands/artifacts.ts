import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { shortId } from '@agor/core/db';
import type { Artifact } from '@agor/core/types';
import type {
  BranchArtifactLandPayload,
  BranchArtifactPublishPayload,
  BranchArtifactValidatePayload,
  ExecutorResult,
} from '../payload-types.js';
import type { AgorClient } from '../services/feathers-client.js';
import { createExecutorClient } from '../services/feathers-client.js';
import { resolveExecutorBranch, resolvePathInsideBranch } from './branch-filesystem.js';
import type { CommandOptions } from './index.js';

export async function readArtifactTree(
  root: string,
  directory = root
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const fullPath = join(directory, entry.name);
    const stats = await lstat(fullPath);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      Object.assign(files, await readArtifactTree(root, fullPath));
    } else if (stats.isFile()) {
      const relativePath = relative(root, fullPath).split(sep).join('/');
      if (relativePath === 'agor.artifact.json' || relativePath === '.env') continue;
      files[`/${relativePath}`] = await readFile(fullPath, 'utf-8');
    }
  }
  return files;
}

export async function handleBranchArtifactValidate(
  payload: BranchArtifactValidatePayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) return { success: true, data: { dryRun: true, command: payload.command } };
  let client: AgorClient | null = null;
  try {
    client = await createExecutorClient(
      payload.daemonUrl || 'http://localhost:3030',
      payload.sessionToken
    );
    const branch = await resolveExecutorBranch(client, payload.params.branchId);
    const source = await resolvePathInsideBranch(branch.path, payload.params.subpath, {
      mustExist: true,
    });
    const files = await readArtifactTree(source.absolute);
    const sidecar = await readArtifactSidecar(source.absolute);
    const artifacts = client.service('artifacts') as unknown as {
      validateFromExecutor(data: {
        files: Record<string, string>;
        sidecar: Record<string, unknown> | null;
      }): Promise<unknown>;
    };
    return { success: true, data: await artifacts.validateFromExecutor({ files, sidecar }) };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'BRANCH_ARTIFACT_VALIDATE_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    try {
      client?.io.disconnect();
    } catch {
      // Ignore disconnect errors.
    }
  }
}

function defaultLandFolder(artifact: Artifact): string {
  const slug = artifact.name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const folder = slug ? `${slug}-${shortId(artifact.artifact_id)}` : artifact.artifact_id;
  return join('.agor', 'artifacts', folder);
}

export async function handleBranchArtifactLand(
  payload: BranchArtifactLandPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) return { success: true, data: { dryRun: true, command: payload.command } };
  let client: AgorClient | null = null;
  try {
    client = await createExecutorClient(
      payload.daemonUrl || 'http://localhost:3030',
      payload.sessionToken
    );
    const branch = await resolveExecutorBranch(client, payload.params.branchId);
    const artifact = await client.service('artifacts').get(payload.params.artifactId);
    if (!artifact.files || Object.keys(artifact.files).length === 0) {
      throw new Error(`Artifact ${artifact.artifact_id} has no stored files to land`);
    }
    const destination = await resolvePathInsideBranch(
      branch.path,
      payload.params.subpath?.trim() || defaultLandFolder(artifact)
    );
    if (destination.relative === '') throw new Error('Destination must not be the branch root');
    try {
      await lstat(destination.absolute);
      if (!payload.params.overwrite) {
        throw new Error(`Destination already exists: ${destination.relative}`);
      }
      await rm(destination.absolute, { recursive: true, force: true });
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    }
    await mkdir(destination.absolute, { recursive: true });

    let fileCount = 0;
    let bytesWritten = 0;
    for (const [rawPath, content] of Object.entries(artifact.files)) {
      const filePath = rawPath.replace(/^\/+/, '');
      const target = await resolvePathInsideBranch(
        branch.path,
        join(destination.relative, filePath)
      );
      await mkdir(dirname(target.absolute), { recursive: true });
      await writeFile(target.absolute, content, 'utf-8');
      fileCount++;
      bytesWritten += Buffer.byteLength(content, 'utf-8');
    }
    const sidecar = `${JSON.stringify(
      {
        $schema: 'https://agor.live/schemas/artifact/2026-05-09.json',
        template: artifact.template,
        sandpack_config: artifact.sandpack_config ?? {},
        required_env_vars: artifact.required_env_vars ?? [],
        agor_grants: artifact.agor_grants ?? {},
        agor_runtime: artifact.agor_runtime ?? {},
      },
      null,
      2
    )}\n`;
    await writeFile(join(destination.absolute, 'agor.artifact.json'), sidecar, 'utf-8');
    fileCount++;
    bytesWritten += Buffer.byteLength(sidecar, 'utf-8');
    return {
      success: true,
      data: { branchId: branch.branch_id, subpath: destination.relative, fileCount, bytesWritten },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'BRANCH_ARTIFACT_LAND_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    try {
      client?.io.disconnect();
    } catch {
      // Ignore disconnect errors.
    }
  }
}

async function readArtifactSidecar(root: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await readFile(join(root, 'agor.artifact.json'), 'utf-8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null;
    throw new Error(
      `Failed to parse agor.artifact.json: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function handleBranchArtifactPublish(
  payload: BranchArtifactPublishPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) return { success: true, data: { dryRun: true, command: payload.command } };
  let client: AgorClient | null = null;
  try {
    client = await createExecutorClient(
      payload.daemonUrl || 'http://localhost:3030',
      payload.sessionToken
    );
    const branch = await resolveExecutorBranch(client, payload.params.branchId);
    const source = await resolvePathInsideBranch(branch.path, payload.params.subpath, {
      mustExist: true,
    });
    const stats = await lstat(source.absolute);
    if (!stats.isDirectory())
      throw new Error(`Artifact source is not a directory: ${source.relative}`);

    const files = await readArtifactTree(source.absolute);
    const sidecar = await readArtifactSidecar(source.absolute);
    const artifacts = client.service('artifacts') as unknown as {
      publishFromExecutor(
        data: Record<string, unknown>
      ): Promise<{ artifact_id: string; content_hash?: string; build_status: string }>;
    };
    const artifact = await artifacts.publishFromExecutor({
      ...payload.params.publishData,
      branch_id: branch.branch_id,
      subpath: source.relative,
      files,
      sidecar,
    });
    return {
      success: true,
      data: {
        artifactId: artifact.artifact_id,
        contentHash: artifact.content_hash,
        buildStatus: artifact.build_status,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'BRANCH_ARTIFACT_PUBLISH_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    try {
      client?.io.disconnect();
    } catch {
      // Ignore disconnect errors.
    }
  }
}
