import { knowledgeTransferSlug } from '@agor/core/types';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { exportKnowledge, knowledgeTransferClient } from '../../lib/knowledge/transfer';
import { withKnowledgeTransfer } from '../../lib/knowledge/transfer-lifecycle';

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
    try {
      await withKnowledgeTransfer(
        {
          failureNote:
            'Export incomplete. Completed files are retained. Re-run the same command with --resume; source changes require a fresh directory.',
          cleanup: () => this.cleanupClient(client),
        },
        async ({ signal, progress }) => {
          const result = await exportKnowledge(
            knowledgeTransferClient(client),
            {
              namespace,
              directory: flags.output,
              dryRun: flags['dry-run'],
              resume: flags.resume,
              sourceIdentity: this.deploymentId!,
              signal,
            },
            progress
          );
          this.log(JSON.stringify(result));
        }
      );
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Knowledge export failed');
    }
  }
}
