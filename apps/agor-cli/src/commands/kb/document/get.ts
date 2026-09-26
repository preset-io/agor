import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { getDocument, terminalText } from '../../../lib/knowledge/read';

export default class KnowledgeDocumentGet extends BaseCommand {
  static override description =
    'Read current Markdown by path; piped output preserves the content bytes.';
  static override args = { path: Args.string({ required: true }) };
  static override flags = {
    namespace: Flags.string({ required: true, description: 'Namespace slug' }),
    json: Flags.boolean({ description: 'Output document metadata, version and content as JSON' }),
  };
  async run() {
    const { args, flags } = await this.parse(KnowledgeDocumentGet);
    const client = await this.connectToDaemon();
    try {
      const doc = await getDocument(client, flags.namespace, args.path);
      if (flags.json) this.log(JSON.stringify(doc));
      else {
        const content = doc.content!;
        process.stdout.write(
          process.stdout.isTTY ? content.split('\n').map(terminalText).join('\n') : content
        );
      }
    } finally {
      await this.cleanupClient(client);
    }
  }
}
