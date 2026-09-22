import { knowledgeTransferSlug } from '@agor/core/types';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { KnowledgeProgress } from '../../lib/knowledge/progress';
import { importKnowledge, knowledgeTransferClient } from '../../lib/knowledge/transfer';

export default class KnowledgeImport extends BaseCommand {
  static override description =
    'Plan a current-markdown import into a new private, caller-owned namespace. Add --apply to execute. No overwrite, ACL transfer or deletion.';
  static override args = {
    directory: Args.string({ required: true, description: 'Completed export directory (Linux)' }),
  };
  static override flags = {
    namespace: Flags.string({ required: true, description: 'New destination namespace slug' }),
    apply: Flags.boolean({ description: 'Execute the validated plan', exclusive: ['dry-run'] }),
    'dry-run': Flags.boolean({ description: 'Validate and plan without writes (default)' }),
    resume: Flags.boolean({
      description: 'Resume the same bundle into its original caller-owned namespace',
    }),
  };
  async run() {
    const { args, flags } = await this.parse(KnowledgeImport);
    const namespace = knowledgeTransferSlug.parse(flags.namespace);
    const client = await this.connectToDaemon();
    const progress = new KnowledgeProgress();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
      const result = await importKnowledge(
        knowledgeTransferClient(client),
        {
          namespace,
          directory: args.directory,
          dryRun: !flags.apply,
          resume: flags.resume,
          sourceIdentity: this.deploymentId!,
          signal: controller.signal,
        },
        progress
      );
      this.log(JSON.stringify(result));
    } catch (error) {
      progress.failure(
        'Import incomplete. Committed documents are retained. Re-run the same command with --resume --apply. Conflicts are never overwritten.'
      );
      this.error(error instanceof Error ? error.message : 'Knowledge import failed');
    } finally {
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
      progress.close();
      await this.cleanupClient(client);
    }
  }
}
