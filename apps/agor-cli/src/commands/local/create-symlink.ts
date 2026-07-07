import { createBranchSymlinkAction } from '@agor/core/local-actions';
import { AGOR_HOME_BASE } from '@agor/core/unix';
import { Command, Flags } from '@oclif/core';

export default class CreateSymlink extends Command {
  static override description = 'Create a branch symlink in user home directory (local/offline)';
  static override flags = {
    username: Flags.string({ char: 'u', description: 'Unix username', required: true }),
    'branch-name': Flags.string({ char: 'w', description: 'Branch name/slug', required: true }),
    'branch-path': Flags.string({
      char: 'p',
      description: 'Absolute path to branch directory',
      required: true,
    }),
    'home-base': Flags.string({
      description: 'Base directory for home directories',
      default: AGOR_HOME_BASE,
    }),
    'dry-run': Flags.boolean({
      char: 'n',
      description: 'Show what would be done without making changes',
      default: false,
    }),
    verbose: Flags.boolean({
      char: 'v',
      description: 'Show detailed output including command stdout/stderr',
      default: false,
    }),
  };
  public async run(): Promise<void> {
    const { flags } = await this.parse(CreateSymlink);
    await createBranchSymlinkAction({
      username: flags.username,
      branchName: flags['branch-name'],
      branchPath: flags['branch-path'],
      homeBase: flags['home-base'],
      dryRun: flags['dry-run'],
      verbose: flags.verbose,
      reporter: { log: (message) => this.log(message) },
    });
  }
}
