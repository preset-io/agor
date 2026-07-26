import { lstat, readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { getConnector } from '@agor/core/gateway';
import type { BranchSlackFileUploadPayload, ExecutorResult } from '../payload-types.js';
import type { AgorClient } from '../services/feathers-client.js';
import { createExecutorClient } from '../services/feathers-client.js';
import { resolveExecutorBranch, resolvePathInsideBranch } from './branch-filesystem.js';
import type { CommandOptions } from './index.js';

interface SlackUploader {
  uploadFile(input: {
    channel: string;
    threadTs?: string;
    file: Buffer;
    filename: string;
    comment?: string;
  }): Promise<unknown>;
}

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
    const connector = getConnector('slack', payload.params.connectorConfig);
    const uploader = connector as unknown as Partial<SlackUploader>;
    if (typeof uploader.uploadFile !== 'function') {
      throw new Error('Configured Slack connector does not support file uploads');
    }
    const uploaded = await uploader.uploadFile({
      channel: payload.params.channel,
      ...(payload.params.threadTs ? { threadTs: payload.params.threadTs } : {}),
      file: await readFile(source.absolute),
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
