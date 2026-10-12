import { knowledgeTransferSlug } from '@agor/core/types';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { assertKnowledgeDirectorySupported } from '../../lib/knowledge/directory';
import { importKnowledge, knowledgeTransferClient } from '../../lib/knowledge/transfer';
import { withKnowledgeTransfer } from '../../lib/knowledge/transfer-lifecycle';

export default class KnowledgeImport extends BaseCommand {
  static override description =
    'Plan a current-markdown import into a new private, caller-owned namespace. Add --apply to execute. No overwrite, ACL transfer or deletion.';
  static override args = {
    directory: Args.string({
      required: true,
      description: 'Version 2 Knowledge repository (manifest.yaml and docs/)',
    }),
  };
  static override flags = {
    namespace: Flags.string({ required: true, description: 'New destination namespace slug' }),
    apply: Flags.boolean({ description: 'Execute the validated plan', exclusive: ['dry-run'] }),
    'dry-run': Flags.boolean({ description: 'Validate and plan without writes (default)' }),
    resume: Flags.boolean({
      default: false,
      description: 'Resume the same bundle into its original caller-owned namespace',
    }),
  };
  async run() {
    const { args, flags } = await this.parse(KnowledgeImport);
    const namespace = knowledgeTransferSlug.parse(flags.namespace);
    try {
      // Unsupported platforms fail before any remote work or resume advice.
      assertKnowledgeDirectorySupported();
    } catch (error) {
      this.error((error as Error).message);
    }
    const client = await this.connectToDaemon();
    try {
      await withKnowledgeTransfer(
        {
          failureNote: flags.apply
            ? 'Import incomplete. Any previously committed documents are retained; conflicts are never overwritten. Resolve the reported error, then check the same bundle with --resume --dry-run (without --apply) before applying again.'
            : 'Planning incomplete. This run sent no import writes. Resolve the reported error before retrying; existing destination data and local checkpoints are unchanged.',
          cleanup: () => this.cleanupClient(client),
        },
        async ({ signal, progress }) => {
          const result = await importKnowledge(
            knowledgeTransferClient(client),
            {
              namespace,
              directory: args.directory,
              dryRun: !flags.apply,
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
      this.error(error instanceof Error ? error.message : 'Knowledge import failed');
    }
  }
}
