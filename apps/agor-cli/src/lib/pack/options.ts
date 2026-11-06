/** Flags and helpers shared by `agor pack export`, `import`, and `send`. */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { uploadPackChunked } from '@agor/core/agor-pack/upload-client';
import { shortId } from '@agor/core/db';
import {
  AGOR_PACK_DEFAULT_SESSION_MODE,
  type AgorPackExportRequest,
  type AgorPackImport,
} from '@agor/core/types';
import { Flags } from '@oclif/core';
import chalk from 'chalk';
import { packJson } from './http';

const SESSION_MODES: Record<string, NonNullable<AgorPackExportRequest['sessions']>> = {
  none: 'none',
  '90d': 'last_90_days',
  all: 'all',
};
const DEFAULT_SESSIONS_FLAG = Object.keys(SESSION_MODES).find(
  (key) => SESSION_MODES[key] === AGOR_PACK_DEFAULT_SESSION_MODE
) as string;

export const packContentFlags = {
  sessions: Flags.string({
    description: 'Session history to include',
    options: Object.keys(SESSION_MODES),
    default: DEFAULT_SESSIONS_FLAG,
  }),
  'include-others-sessions': Flags.boolean({
    description: "Also include other people's sessions on these teammates",
    default: false,
  }),
};

/** The export request body for these flags. */
export function exportRequest(
  branchIds: string[],
  flags: { sessions: string; 'include-others-sessions': boolean }
): AgorPackExportRequest {
  return {
    branch_ids: branchIds,
    sessions: SESSION_MODES[flags.sessions] ?? AGOR_PACK_DEFAULT_SESSION_MODE,
    include_others_sessions: flags['include-others-sessions'],
  };
}

type Log = (line: string) => void;

/**
 * Upload (or resume) a pack file to `baseUrl` with the resumable chunked
 * upload and return its dry-run receipt.
 */
export async function uploadPackFile(input: {
  baseUrl: string;
  bearer: string;
  file: string;
  log: Log;
}): Promise<AgorPackImport> {
  const { size } = await stat(input.file);
  const hash = createHash('sha256');
  await pipeline(createReadStream(input.file), hash);
  const file = await open(input.file, 'r');
  try {
    let reported = -1;
    return await uploadPackChunked({
      size,
      sha256: hash.digest('hex'),
      readChunk: async (start, end) => {
        const buffer = Buffer.alloc(end - start);
        await file.read(buffer, 0, buffer.byteLength, start);
        return buffer;
      },
      send: (path, init) =>
        fetch(`${input.baseUrl.replace(/\/$/, '')}${path}`, {
          ...init,
          body: init.body as RequestInit['body'],
          headers: { Authorization: `Bearer ${input.bearer}`, ...(init.headers ?? {}) },
          redirect: 'error',
        }),
      onProgress: (sent, total) => {
        const percent = Math.floor((sent / total) * 100);
        if (percent >= reported + 10 || sent === total) {
          reported = percent;
          input.log(chalk.dim(`  ${percent}%`));
        }
      },
    });
  } finally {
    await file.close();
  }
}

export function printDryRun(log: Log, receipt: AgorPackImport): void {
  for (const teammate of receipt.dry_run) {
    const done = teammate.already_imported_branch_id ? chalk.green(' (already imported)') : '';
    log(
      `  ${chalk.bold(teammate.key)} ${teammate.display_name} — repo ${teammate.repo_status}${done}`
    );
    for (const warning of teammate.warnings) log(chalk.yellow(`    ! ${warning}`));
  }
}

/** Apply a staged pack on a daemon and follow the receipt until the rows are in. */
export async function applyPack(input: {
  daemonUrl: string;
  bearer: string;
  receipt: AgorPackImport;
  teammates?: string;
  boardId: string | null;
  log: Log;
}): Promise<AgorPackImport> {
  const { daemonUrl, bearer, log } = input;
  const keys = input.teammates
    ? input.teammates.split(',').map((key) => key.trim())
    : input.receipt.manifest.teammates.map((t) => t.key);
  let receipt = await packJson<AgorPackImport>(
    daemonUrl,
    bearer,
    `/agor-pack/imports/${input.receipt.import_id}/apply`,
    { teammates: keys, board_id: input.boardId }
  );
  while (receipt.status === 'applying') {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    receipt = await packJson<AgorPackImport>(
      daemonUrl,
      bearer,
      `/agor-pack/imports/${receipt.import_id}`
    );
  }
  if (receipt.status === 'failed') {
    throw new Error(`${receipt.error ?? 'apply failed'} (run the command again to resume)`);
  }
  for (const result of receipt.results) {
    log(
      chalk.green(`✓ ${result.display_name} → branch ${shortId(result.branch_id)}`) +
        chalk.dim(` (files: ${result.filesystem})`)
    );
    for (const warning of result.warnings) log(chalk.yellow(`    ! ${warning}`));
  }
  return receipt;
}
