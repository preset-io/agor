import { Args, Command } from '@oclif/core';
import { validateKnowledgeRepository } from '../../lib/knowledge/repository';

/** Deliberately does not extend BaseCommand: no login, daemon, or network I/O. */
export default class KnowledgeValidate extends Command {
  static override description =
    'Validate a version 2 Knowledge repository locally, without login or writes. Reports unlisted files and unresolved links.';
  static override args = {
    directory: Args.string({ required: true, description: 'Knowledge repository directory' }),
  };
  async run() {
    const { args } = await this.parse(KnowledgeValidate);
    try {
      this.log(JSON.stringify(await validateKnowledgeRepository(args.directory)));
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Knowledge repository validation failed');
    }
  }
}
