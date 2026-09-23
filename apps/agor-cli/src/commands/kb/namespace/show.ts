import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { namespaceBySlug, table } from '../../../lib/knowledge/read';

export default class KnowledgeNamespaceShow extends BaseCommand {
  static override description = 'Show an accessible namespace by slug.';
  static override args = { slug: Args.string({ required: true }) };
  static override flags = { json: Flags.boolean({ description: 'Output namespace JSON' }) };
  async run() {
    const { args, flags } = await this.parse(KnowledgeNamespaceShow);
    const client = await this.connectToDaemon();
    try {
      const ns = await namespaceBySlug(client, args.slug);
      this.log(
        flags.json
          ? JSON.stringify(ns)
          : table(
              ['Field', 'Value'],
              [
                ['Slug', ns.slug],
                ['Name', ns.display_name],
                ['Description', ns.description],
                ['ID', ns.namespace_id],
                ['Kind', ns.kind],
                ['Permission', ns.effective_permission],
                ['Default visibility', ns.visibility_default],
                ['Owner ID', ns.owner_user_id],
                ['Created', ns.created_at],
                ['Modified', ns.updated_at],
              ]
            )
      );
    } finally {
      await this.cleanupClient(client);
    }
  }
}
