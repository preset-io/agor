/** Flags and helpers shared by `agor pack export`, `import`, and `send`. */

import { shortId } from '@agor/core/db';
import {
  AGOR_PACK_DEFAULT_SESSION_MODE,
  AGOR_PACK_SECTIONS,
  type AgorPackExportRequest,
  type AgorPackImport,
  type AgorPackSection,
} from '@agor/core/types';
import { Flags } from '@oclif/core';
import chalk from 'chalk';
import { packJson } from './http';

const SESSION_MODES: Record<string, AgorPackExportRequest['sessions']> = {
  none: 'none',
  '30d': 'last_30_days',
  all: 'all',
};
const DEFAULT_SESSIONS_FLAG = Object.keys(SESSION_MODES).find(
  (key) => SESSION_MODES[key] === AGOR_PACK_DEFAULT_SESSION_MODE
) as string;

export const packContentFlags = {
  sections: Flags.string({
    description: `Comma-separated sections (${AGOR_PACK_SECTIONS.join(', ')}); default: all`,
  }),
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

/** The export request body for these flags; throws on an unknown section. */
export function exportRequest(
  branchIds: string[],
  flags: { sections?: string; sessions: string; 'include-others-sessions': boolean }
): AgorPackExportRequest {
  const sections = flags.sections
    ? flags.sections.split(',').map((value) => value.trim())
    : [...AGOR_PACK_SECTIONS];
  for (const section of sections) {
    if (!(AGOR_PACK_SECTIONS as readonly string[]).includes(section)) {
      throw new Error(
        `Unknown section "${section}". Choose from: ${AGOR_PACK_SECTIONS.join(', ')}`
      );
    }
  }
  return {
    branch_ids: branchIds,
    sections: sections as AgorPackSection[],
    sessions: SESSION_MODES[flags.sessions] ?? AGOR_PACK_DEFAULT_SESSION_MODE,
    include_others_sessions: flags['include-others-sessions'],
  };
}

type Log = (line: string) => void;

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
