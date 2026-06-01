/**
 * `agor branch list` - List branches
 *
 * Shows all branches, optionally filtered by repository.
 */

import type { Branch, Repo } from '@agor-live/client';
import { PAGINATION, shortId } from '@agor-live/client';
import { Flags } from '@oclif/core';
import chalk from 'chalk';
import Table from 'cli-table3';
import { BaseCommand } from '../../base-command';

export default class BranchList extends BaseCommand {
  static description = 'List git branches';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --all',
    '<%= config.bin %> <%= command.id %> --archived',
    '<%= config.bin %> <%= command.id %> --repo-id 01933e4a',
  ];

  static flags = {
    'repo-id': Flags.string({
      description: 'Filter by repository ID',
    }),
    all: Flags.boolean({
      description: 'Show both active and archived branches',
      default: false,
    }),
    archived: Flags.boolean({
      description: 'Show only archived branches',
      default: false,
    }),
    limit: Flags.integer({
      char: 'l',
      description: 'Maximum number of branches to show',
      default: PAGINATION.CLI_DEFAULT_LIMIT,
    }),
  };

  /**
   * Format relative time
   */
  private formatRelativeTime(isoDate: string): string {
    const now = Date.now();
    const date = new Date(isoDate).getTime();
    const diff = now - date;

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return `${seconds}s ago`;
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(BranchList);

    // Connect to daemon (auto-authenticates)
    const client = await this.connectToDaemon();

    try {
      const branchesService = client.service('branches');
      const reposService = client.service('repos');

      // Fetch branches - optionally filtered by repo ID
      // Use high limit to get all, then filter/limit client-side for accurate counts
      let allBranches: Branch[] = [];

      if (flags['repo-id']) {
        // Filter by repo ID
        allBranches = await branchesService.findAll({
          query: { repo_id: flags['repo-id'], $limit: PAGINATION.DEFAULT_LIMIT },
        });
      } else {
        // Show all branches
        allBranches = await branchesService.findAll({
          query: { $limit: PAGINATION.DEFAULT_LIMIT },
        });
      }

      // Filter by archive status
      let filteredBranches = allBranches;
      if (flags.archived) {
        filteredBranches = allBranches.filter((w) => w.archived);
      } else if (!flags.all) {
        // Default: show only active (not archived)
        filteredBranches = allBranches.filter((w) => !w.archived);
      }

      // Sort by last_used/created_at descending (most recent first)
      filteredBranches.sort((a, b) => {
        const aDate = new Date(a.last_used || a.created_at).getTime();
        const bDate = new Date(b.last_used || b.created_at).getTime();
        return bDate - aDate;
      });

      // Track total before applying limit
      const totalFiltered = filteredBranches.length;

      // Apply display limit
      const displayBranches = filteredBranches.slice(0, flags.limit);

      if (filteredBranches.length === 0) {
        this.log(chalk.dim('No branches found.'));
        this.log('');
        this.log(`Create one with: ${chalk.cyan('agor branch add <name> --repo-id <id>')}`);
        this.log('');
        await this.cleanupClient(client);
        process.exit(0);
        return;
      }

      this.log('');

      // Fetch repo details for each branch's repo_id
      const repoCache = new Map<string, Repo>();
      for (const wt of allBranches) {
        if (!repoCache.has(wt.repo_id)) {
          try {
            const repo = await reposService.get(wt.repo_id);
            repoCache.set(wt.repo_id, repo);
          } catch {
            // Repo might have been deleted, use ID as fallback
          }
        }
      }

      // Query all sessions and count by branch_id
      const sessionsService = client.service('sessions');
      const sessionCounts = new Map<string, number>();

      try {
        // Fetch all sessions (use high limit to get all for accurate counts)
        const allSessions = await sessionsService.findAll({
          query: { $limit: PAGINATION.DEFAULT_LIMIT },
        });

        // Count sessions per branch
        for (const session of allSessions) {
          const count = sessionCounts.get(session.branch_id) || 0;
          sessionCounts.set(session.branch_id, count + 1);
        }
      } catch {
        // If sessions fetch fails, all counts remain 0
      }

      // Display simple flat table
      const table = new Table({
        head: [
          chalk.cyan('ID'),
          chalk.cyan('Repo'),
          chalk.cyan('Name'),
          chalk.cyan('Branch'),
          chalk.cyan('Sessions'),
          chalk.cyan('Last Used'),
        ],
        style: {
          head: [],
          border: ['dim'],
        },
        colWidths: [10, 18, 18, 22, 10, 15],
      });

      for (const branch of displayBranches) {
        const repo = repoCache.get(branch.repo_id);
        const sessionCount = sessionCounts.get(branch.branch_id) || 0;
        const nameDisplay = branch.archived ? `${branch.name} ${chalk.dim('□')}` : branch.name;
        table.push([
          chalk.dim(shortId(branch.branch_id)),
          repo ? repo.slug : chalk.dim(shortId(branch.repo_id)),
          nameDisplay,
          branch.ref,
          sessionCount.toString(),
          chalk.dim(this.formatRelativeTime(branch.last_used || branch.created_at)),
        ]);
      }

      this.log(table.toString());
      this.log('');

      // Show count with "of total" if limited
      if (displayBranches.length < totalFiltered) {
        this.log(chalk.dim(`Showing ${displayBranches.length} of ${totalFiltered} branch(s)`));
      } else {
        this.log(chalk.dim(`Showing ${displayBranches.length} branch(s)`));
      }
      this.log('');

      // Cleanup
      await this.cleanupClient(client);
      process.exit(0);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to list branches: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
