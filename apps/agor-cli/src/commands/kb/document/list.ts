import type { KnowledgeDocumentStatus } from '@agor/core/types';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { listDocuments, page, pageSummary, table } from '../../../lib/knowledge/read';

export default class KnowledgeDocumentList extends BaseCommand {
  static override description =
    'List accessible active documents. Pagination limits displayed rows; existing APIs fetch the authorized inventory.';
  static override flags = {
    namespace: Flags.string({ required: true, description: 'Namespace slug' }),
    status: Flags.string({
      options: ['published', 'draft'],
      description: 'Filter by status (default: both)',
    }),
    limit: Flags.integer({ default: 50, min: 1, description: 'Maximum rows to display' }),
    offset: Flags.integer({ default: 0, min: 0, description: 'Number of sorted rows to skip' }),
    json: Flags.boolean({ description: 'Output JSON with total, limit, offset and data' }),
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
      if (flags.json) this.log(JSON.stringify(result));
      else {
        this.log(
          table(
            ['Path', 'Title', 'Kind', 'Status', 'Modified'],
            result.data.map((row) => [row.path, row.title, row.kind, row.status, row.updated_at])
          )
        );
        this.log(pageSummary(result));
      }
    } finally {
      await this.cleanupClient(client);
    }
  }
}
