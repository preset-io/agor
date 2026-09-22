import type { KnowledgeDocumentStatus } from '@agor/core/types';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import {
  knowledgeListFlags,
  listDocuments,
  page,
  renderKnowledgePage,
} from '../../../lib/knowledge/read';

export default class KnowledgeDocumentList extends BaseCommand {
  static override description =
    'List accessible active documents. Pagination limits displayed rows; existing APIs fetch the authorized inventory.';
  static override flags = {
    namespace: Flags.string({ required: true, description: 'Namespace slug' }),
    status: Flags.string({
      options: ['published', 'draft'],
      description: 'Filter by status (default: both)',
    }),
    ...knowledgeListFlags(),
  };
  async run() {
    const { flags } = await this.parse(KnowledgeDocumentList);
    const client = await this.connectToDaemon();
    try {
      const result = page(
        await listDocuments(
          client,
          flags.namespace,
          flags.status as KnowledgeDocumentStatus | undefined
        ),
        flags.limit,
        flags.offset
      );
      this.log(
        renderKnowledgePage(
          result,
          flags.json,
          ['Path', 'Title', 'Kind', 'Status', 'Modified'],
          (row) => [row.path, row.title, row.kind, row.status, row.updated_at]
        )
      );
    } finally {
      await this.cleanupClient(client);
    }
  }
}
