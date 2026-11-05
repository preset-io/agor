/**
 * `agor pack send` — export AI teammates from this install and import them
 * straight into an Agor Cloud workspace with a Cloud API key. The Settings UI
 * signs in through the browser instead; this is the scripted fallback.
 */

import {
  type AgorPackImport,
  type AgorPackManifest,
  agorCloudReconnectUrl,
} from '@agor/core/types';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';
import { packFetch, packJson } from '../../lib/pack/http';
import { applyPack, exportRequest, packContentFlags, printDryRun } from '../../lib/pack/options';

export default class PackSend extends BaseCommand {
  static override summary = 'Send AI teammates to an Agor Cloud workspace';
  static override description =
    'Exports the teammates from the connected daemon and uploads the pack to an Agor Cloud ' +
    'workspace with a personal API key from that workspace, read from an environment variable. ' +
    'Prints the dry-run; with --apply, imports them (each on a new board) and prints the link ' +
    'to the reconnect checklist in Cloud. Sending the same pack again changes nothing.';

  static override examples = [
    'AGOR_CLOUD_API_KEY=agor_sk_… <%= config.bin %> <%= command.id %> 01933e4a --cloud-url https://acme.dp-us1a.agor.cloud --api-key-env AGOR_CLOUD_API_KEY --apply',
  ];

  static override strict = false;

  static override args = {
    teammate: Args.string({ description: 'Teammate branch ID (one or more)', required: true }),
  };

  static override flags = {
    'cloud-url': Flags.string({ description: 'Agor Cloud workspace URL', required: true }),
    'api-key-env': Flags.string({
      description: 'Environment variable holding a personal API key of that workspace',
      required: true,
    }),
    ...packContentFlags,
    apply: Flags.boolean({ description: 'Import after the dry-run', default: false }),
    teammates: Flags.string({ description: 'Comma-separated teammate keys (default: all)' }),
  };

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(PackSend);
    const cloudKey = process.env[flags['api-key-env']]?.trim();
    if (!cloudKey) this.error(`Set ${flags['api-key-env']} to an API key of the Cloud workspace.`);
    let cloudUrl: string;
    try {
      const url = new URL(flags['cloud-url']);
      if (url.protocol !== 'https:') throw new Error('not https');
      cloudUrl = url.origin;
    } catch {
      this.error('--cloud-url must be the https URL of your Agor Cloud workspace.');
    }
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
      this.logToStderr(chalk.dim(`Sending ${exported.size} bytes to ${new URL(cloudUrl).host}…`));
      const uploaded = await packFetch(cloudUrl, cloudKey, '/agor-pack/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip', 'Content-Length': String(exported.size) },
        body: download.body,
        duplex: 'half',
        redirect: 'error',
      } as RequestInit);
      let receipt = (await uploaded.json()) as AgorPackImport;
      printDryRun((line) => this.logToStderr(line), receipt);
      if (flags.apply) {
        receipt = await applyPack({
          daemonUrl: cloudUrl,
          bearer: cloudKey,
          receipt,
          teammates: flags.teammates,
          boardId: null,
          log: (line) => this.logToStderr(line),
        });
        this.logToStderr(
          `Reconnect credentials in Cloud: ${agorCloudReconnectUrl(cloudUrl, receipt.import_id)}`
        );
      }
      this.log(JSON.stringify(receipt));
    } catch (error) {
      this.error(`Send failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await this.cleanupClient(client);
    }
  }
}
