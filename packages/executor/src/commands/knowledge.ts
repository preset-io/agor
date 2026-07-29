import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  BranchKnowledgeReadPayload,
  BranchKnowledgeWritePayload,
  ExecutorResult,
} from '../payload-types.js';
import type { AgorClient } from '../services/feathers-client.js';
import { createExecutorClient } from '../services/feathers-client.js';
import { resolveExecutorBranch, resolvePathInsideBranch } from './branch-filesystem.js';
import type { CommandOptions } from './index.js';

function sidecarSubpath(subpath: string): string {
  return `${subpath}.agor-kb.json`;
}

async function withClient<T>(
  payload: BranchKnowledgeReadPayload | BranchKnowledgeWritePayload,
  callback: (client: AgorClient) => Promise<T>
): Promise<T> {
  const client = await createExecutorClient(
    payload.daemonUrl || 'http://localhost:3030',
    payload.sessionToken
  );
  try {
    return await callback(client);
  } finally {
    try {
      client.io.disconnect();
    } catch {
      // Ignore disconnect errors.
    }
  }
}

export async function handleBranchKnowledgeWrite(
  payload: BranchKnowledgeWritePayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) return { success: true, data: { dryRun: true, command: payload.command } };
  try {
    return await withClient(payload, async (client) => {
      const branch = await resolveExecutorBranch(client, payload.params.branchId);
      const document = await resolvePathInsideBranch(branch.path, payload.params.subpath);
      const sidecar = await resolvePathInsideBranch(branch.path, sidecarSubpath(document.relative));
      if (!payload.params.overwrite) {
        for (const candidate of [document.absolute, sidecar.absolute]) {
          try {
            await lstat(candidate);
            throw new Error(`Destination already exists: ${document.relative}`);
          } catch (error) {
            if ((error as { code?: string }).code !== 'ENOENT') throw error;
          }
        }
      }
      await mkdir(dirname(document.absolute), { recursive: true });
      await writeFile(document.absolute, payload.params.content, 'utf-8');
      await mkdir(dirname(sidecar.absolute), { recursive: true });
      await writeFile(
        sidecar.absolute,
        `${JSON.stringify(payload.params.sidecar, null, 2)}\n`,
        'utf-8'
      );
      return {
        success: true,
        data: {
          branchId: branch.branch_id,
          subpath: document.relative,
          sidecarSubpath: sidecar.relative,
          bytesWritten: Buffer.byteLength(payload.params.content, 'utf-8'),
        },
      };
    });
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'BRANCH_KNOWLEDGE_WRITE_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function handleBranchKnowledgeRead(
  payload: BranchKnowledgeReadPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) return { success: true, data: { dryRun: true, command: payload.command } };
  try {
    return await withClient(payload, async (client) => {
      const branch = await resolveExecutorBranch(client, payload.params.branchId);
      const document = await resolvePathInsideBranch(branch.path, payload.params.subpath, {
        mustExist: true,
      });
      const content = await readFile(document.absolute, 'utf-8');
      const sidecarPath = await resolvePathInsideBranch(
        branch.path,
        sidecarSubpath(document.relative)
      );
      let sidecar: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(await readFile(sidecarPath.absolute, 'utf-8')) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          sidecar = parsed as Record<string, unknown>;
        }
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error;
      }
      return {
        success: true,
        data: {
          branchId: branch.branch_id,
          subpath: document.relative,
          sidecarSubpath: sidecarPath.relative,
          content,
          sidecar,
        },
      };
    });
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'BRANCH_KNOWLEDGE_READ_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
