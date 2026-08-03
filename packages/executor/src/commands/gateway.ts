import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
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
    const response = await fetch(
      `${payload.daemonUrl || 'http://localhost:3030'}/executor/gateway/slack-file-upload`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${payload.sessionToken}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(stats.size),
          'X-Agor-Gateway-Channel-Id': payload.params.gatewayChannelId,
          'X-Agor-Slack-Channel-Id': payload.params.channel,
          'X-Agor-Filename': encodeURIComponent(
            payload.params.filename ?? basename(source.absolute)
          ),
          ...(payload.params.threadTs ? { 'X-Agor-Thread-Ts': payload.params.threadTs } : {}),
          ...(payload.params.comment
            ? { 'X-Agor-Comment': encodeURIComponent(payload.params.comment) }
            : {}),
        },
        body: createReadStream(source.absolute) as never,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }
    );
    if (!response.ok) {
      throw new Error(`Slack upload failed with HTTP ${response.status}`);
    }
    const result = (await response.json()) as { uploaded?: unknown };
    return { success: true, data: { uploaded: result.uploaded } };
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
