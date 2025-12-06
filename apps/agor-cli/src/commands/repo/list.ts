/**
 * `agor repo list` - List all registered repositories
 *
 * Displays repositories in a beautiful table.
 */

import { PAGINATION } from '@agor/core/config';
import { formatShortId } from '@agor/core/db';
import type { Repo } from '@agor/core/types';
import { Flags } from '@oclif/core';
import chalk from 'chalk';
import Table from 'cli-table3';
import { BaseCommand } from '../../base-command';

// Type for paginated responses
interface Paginated<T> {
  total: number;
  limit: number;
  skip: number;
  data: T[];
}

export default class RepoList extends BaseCommand {
  static description = 'List all registered repositories';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  static flags = {
    limit: Flags.integer({
      char: 'l',
      description: 'Maximum number of repos to show',
      default: PAGINATION.CLI_DEFAULT_LIMIT,
    }),
  };

  /**
   * Truncate text to max length
   */
  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 3)}...`;
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(RepoList);
    const client = await this.connectToDaemon();

    try {
      // Build query
      const query = {
        $limit: flags.limit,
        $sort: { created_at: -1 }, // Most recent first
      };

      // Fetch repos
      const reposService = client.service('repos');
      const result = await reposService.find({ query });
      const isPaginated = !Array.isArray(result);
      const repos = Array.isArray(result) ? result : (result as Paginated<Repo>).data;
      const total = isPaginated ? (result as Paginated<Repo>).total : repos.length;

      if (!Array.isArray(repos) || repos.length === 0) {
        this.log(chalk.dim('No repositories found.'));
        this.log('');
        this.log(
          `Add one with: ${chalk.cyan('agor repo add <git-url>')} or ${chalk.cyan(
            'agor repo add-local <path>'
          )}`
        );
        this.log('');
        await this.cleanupClient(client);
        return;
      }

      // Create table
      const table = new Table({
        head: [
          chalk.cyan('ID'),
          chalk.cyan('Slug'),
          chalk.cyan('Type'),
          chalk.cyan('Remote URL'),
          chalk.cyan('Path'),
          chalk.cyan('Default Branch'),
        ],
        style: {
          head: [],
          border: ['dim'],
        },
        colWidths: [10, 22, 10, 38, 32, 15],
      });

      // Add rows
      for (const repo of repos) {
        const shortId = formatShortId(repo.repo_id);

        table.push([
          chalk.dim(shortId),
          repo.slug,
          repo.repo_type,
          this.truncate(repo.remote_url || '(no remote)', 35),
          chalk.dim(this.truncate(repo.local_path, 30)),
          chalk.dim(repo.default_branch || '-'),
        ]);
      }

      // Display
      this.log('');
      this.log(table.toString());
      this.log('');
      if (isPaginated && total > repos.length) {
        this.log(chalk.dim(`Showing ${repos.length} of ${total} repo(s)`));
      } else {
        this.log(chalk.dim(`Showing ${repos.length} repo(s)`));
      }
      this.log('');

      await this.cleanupClient(client);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to fetch repos: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
