import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { listNamespaces, page, pageSummary, table } from '../../../lib/knowledge/read';

export default class KnowledgeNamespaceList extends BaseCommand {
  static override description =
    'List accessible active namespaces. Pagination limits displayed rows; existing APIs fetch the authorized inventory.';
  static override flags = {
    limit: Flags.integer({ default: 50, min: 1, description: 'Maximum rows to display' }),
    offset: Flags.integer({ default: 0, min: 0, description: 'Number of sorted rows to skip' }),
    json: Flags.boolean({ description: 'Output JSON with total, limit, offset and data' }),
  };
  async run() {
    const { flags } = await this.parse(KnowledgeNamespaceList);
    const client = await this.connectToDaemon();
    try {
      const result = page(await listNamespaces(client), flags.limit, flags.offset);
      if (flags.json) this.log(JSON.stringify(result));
      else {
        this.log(
          table(
            ['Slug', 'Name', 'Kind', 'Permission', 'Modified'],
            result.data.map((row) => [
              row.slug,
              row.display_name,
              row.kind,
              row.effective_permission,
              row.updated_at,
            ])
          )
        );
        this.log(pageSummary(result));
      }
    } finally {
      await this.cleanupClient(client);
    }
  }
}
