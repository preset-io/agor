/**
 * `agor pack send` — export AI teammates from this install and import them
 * straight into another self-hosted Agor with a personal API key from it.
 * Agor Cloud workspaces don't take personal API keys for this; moving there
 * goes through Settings → Move to Agor Cloud (or an .agor file).
 */

import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AGOR_PACK,
  type AgorPackImport,
  type AgorPackManifest,
  agorPackImportPath,
  isPrivateNetworkHost,
} from '@agor/core/types';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';
import { packFetch, packJson } from '../../lib/pack/http';
import {
  applyPack,
  exportRequest,
  isAgorCloudHost,
  packContentFlags,
  printDryRun,
  uploadPackFile,
} from '../../lib/pack/options';

const AGOR_CLOUD_REFUSAL =
  'Agor Cloud workspaces cannot be sent to with an API key. Use Settings → Move to Agor Cloud, ' +
  'or download the .agor file and import it in Agor Cloud.';

export default class PackSend extends BaseCommand {
  static override summary = 'Send AI teammates to another self-hosted Agor';
  static override description =
    'Exports the teammates from the connected daemon and uploads the .agor file to another ' +
    'self-hosted Agor with a personal API key from it, read from an environment variable. ' +
    'Prints the dry-run; with --apply, imports them (each on a new board) and prints the link ' +
    'to Finish setup there. An interrupted upload resumes; sending the same file again changes ' +
    'nothing. For Agor Cloud, use Settings → Move to Agor Cloud.';

  static override examples = [
    'TARGET_AGOR_API_KEY=agor_sk_… <%= config.bin %> <%= command.id %> 01933e4a --to https://agor.example.com --api-key-env TARGET_AGOR_API_KEY --apply',
  ];

  static override strict = false;

  static override args = {
    teammate: Args.string({ description: 'Teammate branch ID (one or more)', required: true }),
  };

  static override flags = {
    to: Flags.string({ description: 'URL of the self-hosted Agor to send to', required: true }),
    'api-key-env': Flags.string({
      description: 'Environment variable holding a personal API key of that Agor',
      required: true,
    }),
    ...packContentFlags,
    apply: Flags.boolean({ description: 'Import after the dry-run', default: false }),
    teammates: Flags.string({ description: 'Comma-separated teammate keys (default: all)' }),
  };

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(PackSend);
    let target: URL;
    try {
      target = new URL(flags.to);
    } catch {
      this.error('--to must be the URL of the Agor to send to.');
    }
    if (await isAgorCloudHost(target.hostname.toLowerCase())) this.error(AGOR_CLOUD_REFUSAL);
    // The API key travels with every request: https, or http on a private network only.
    if (
      target.protocol !== 'https:' &&
      !(target.protocol === 'http:' && isPrivateNetworkHost(target.hostname))
    ) {
      this.error('--to must use https (or http on a private network address).');
    }
    const targetUrl = target.origin;
    const targetKey = process.env[flags['api-key-env']]?.trim();
    if (!targetKey) this.error(`Set ${flags['api-key-env']} to an API key of the target Agor.`);
    const client = await this.connectToDaemon();
    try {
      const branchIds: string[] = [];
      for (const id of argv as string[]) {
        branchIds.push((await client.service('branches').get(id)).branch_id);
      }
      const bearer = await this.resolveHttpBearer();
      const daemonUrl = this.daemonUrl as string;
      this.logToStderr(chalk.dim(`Packing ${branchIds.length} teammate(s)…`));
      const exported = await packJson<{
        export_id: string;
        ref: string;
        size: number;
        manifest: AgorPackManifest;
      }>(daemonUrl, bearer, '/agor-pack/exports', exportRequest(branchIds, flags));
      const download = await packFetch(
        daemonUrl,
        bearer,
        `/agor-pack/downloads/${exported.export_id}/${exported.ref}`
      );
      // The chunked upload needs the file's hash first, so stage it locally.
      const dir = await mkdtemp(join(tmpdir(), 'agor-pack-send-'));
      let receipt: AgorPackImport;
      try {
        const file = join(dir, `export${AGOR_PACK.extension}`);
        await pipeline(
          Readable.fromWeb(download.body as never),
          createWriteStream(file, { mode: 0o600 })
        );
        this.logToStderr(chalk.dim(`Sending ${exported.size} bytes to ${target.host}…`));
        receipt = await uploadPackFile({
          baseUrl: targetUrl,
          bearer: targetKey,
          file,
          log: (line) => this.logToStderr(line),
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      printDryRun((line) => this.logToStderr(line), receipt);
      if (flags.apply) {
        receipt = await applyPack({
          daemonUrl: targetUrl,
          bearer: targetKey,
          receipt,
          teammates: flags.teammates,
          boardId: null,
          log: (line) => this.logToStderr(line),
        });
        this.logToStderr(`Finish setup: ${targetUrl}${agorPackImportPath(receipt.import_id)}`);
      }
      this.log(JSON.stringify(receipt));
    } catch (error) {
      this.error(`Send failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await this.cleanupClient(client);
    }
  }
}
