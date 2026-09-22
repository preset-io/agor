import { BaseCommand } from '../../../base-command';
import {
  knowledgeListFlags,
  listNamespaces,
  page,
  renderKnowledgePage,
} from '../../../lib/knowledge/read';

export default class KnowledgeNamespaceList extends BaseCommand {
  static override description =
    'List accessible active namespaces. Pagination limits displayed rows; existing APIs fetch the authorized inventory.';
  static override flags = {
    ...knowledgeListFlags(),
  };
  async run() {
    const { flags } = await this.parse(KnowledgeNamespaceList);
    const client = await this.connectToDaemon();
    try {
      const result = page(await listNamespaces(client), flags.limit, flags.offset);
      this.log(
        renderKnowledgePage(
          result,
          flags.json,
          ['Slug', 'Name', 'Kind', 'Permission', 'Modified'],
          (row) => [row.slug, row.display_name, row.kind, row.effective_permission, row.updated_at]
        )
      );
    } finally {
      await this.cleanupClient(client);
    }
  }
}
