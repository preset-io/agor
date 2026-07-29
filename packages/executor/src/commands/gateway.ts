import { lstat, readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { BranchSlackFileUploadPayload, ExecutorResult } from '../payload-types.js';
import type { AgorClient } from '../services/feathers-client.js';
import { createExecutorClient } from '../services/feathers-client.js';
import { resolveExecutorBranch, resolvePathInsideBranch } from './branch-filesystem.js';
import type { CommandOptions } from './index.js';

export async function handleBranchSlackFileUpload(
  payload: BranchSlackFileUploadPayload,
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
    const source = await resolvePathInsideBranch(branch.path, payload.params.filePath, {
      mustExist: true,
    });
    const stats = await lstat(source.absolute);
    if (!stats.isFile()) throw new Error(`Not a file: ${source.relative}`);
    if (stats.size > payload.params.maxBytes) {
      throw new Error(
        `File exceeds the ${payload.params.maxBytes}-byte upload limit: ${source.relative} (${stats.size} bytes)`
      );
    }
    const channels = client.service('gateway-channels') as unknown as {
      methods?: (...names: string[]) => unknown;
      uploadFileFromExecutor(data: {
        gatewayChannelId: string;
        channel: string;
        threadTs?: string;
        fileBase64: string;
        filename: string;
        comment?: string;
      }): Promise<unknown>;
    };
    channels.methods?.('uploadFileFromExecutor');
    const uploaded = await channels.uploadFileFromExecutor({
      gatewayChannelId: payload.params.gatewayChannelId,
      channel: payload.params.channel,
      ...(payload.params.threadTs ? { threadTs: payload.params.threadTs } : {}),
      fileBase64: (await readFile(source.absolute)).toString('base64'),
      filename: payload.params.filename ?? basename(source.absolute),
      ...(payload.params.comment ? { comment: payload.params.comment } : {}),
    });
    return { success: true, data: { uploaded } };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'BRANCH_SLACK_FILE_UPLOAD_FAILED',
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
