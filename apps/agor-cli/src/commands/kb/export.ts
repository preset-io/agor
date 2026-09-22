import { knowledgeTransferSlug } from '@agor/core/types';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { KnowledgeProgress } from '../../lib/knowledge/progress';
import { exportKnowledge, knowledgeTransferClient } from '../../lib/knowledge/transfer';

export default class KnowledgeExport extends BaseCommand {
  static override description =
    'Plan and export current Knowledge markdown to a private directory (Linux). Requires workspace admin; excludes history, trash, assets and ACLs.';
  static override flags = {
    namespace: Flags.string({ required: true, description: 'Source namespace slug' }),
    output: Flags.string({
      required: true,
      description: 'Private output directory (0700); created if absent',
    }),
    'dry-run': Flags.boolean({ description: 'Plan only; do not write files' }),
    resume: Flags.boolean({
      description: 'Resume an interrupted export of the same source inventory',
    }),
  };
  async run() {
    const { flags } = await this.parse(KnowledgeExport);
    const namespace = knowledgeTransferSlug.parse(flags.namespace);
    const client = await this.connectToDaemon();
    const progress = new KnowledgeProgress();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
      const result = await exportKnowledge(
        knowledgeTransferClient(client),
        {
          namespace,
          directory: flags.output,
          dryRun: flags['dry-run'],
          resume: flags.resume,
          sourceIdentity: this.deploymentId!,
          signal: controller.signal,
        },
        progress
      );
      this.log(JSON.stringify(result));
    } catch (error) {
      progress.failure(
        'Export incomplete. Completed files are retained. Re-run the same command with --resume; source changes require a fresh directory.'
      );
      this.error(error instanceof Error ? error.message : 'Knowledge export failed');
    } finally {
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
      progress.close();
      await this.cleanupClient(client);
    }
  }
}
