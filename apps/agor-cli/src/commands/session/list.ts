/**
 * `agor session list` - List all sessions
 *
 * Displays sessions in a beautiful table with filters.
 */

import { formatShortId } from '@agor/core/db';
import type { Session } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
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

export default class SessionList extends BaseCommand {
  static description = 'List all sessions';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --status running',
    '<%= config.bin %> <%= command.id %> --agent claude-code',
    '<%= config.bin %> <%= command.id %> --board experiments',
  ];

  static flags = {
    status: Flags.string({
      char: 's',
      description: 'Filter by status',
      options: [
        SessionStatus.IDLE,
        SessionStatus.RUNNING,
        SessionStatus.COMPLETED,
        SessionStatus.FAILED,
      ],
    }),
    agent: Flags.string({
      char: 'a',
      description: 'Filter by agent',
      options: ['claude-code', 'codex', 'gemini'],
    }),
    board: Flags.string({
      char: 'b',
      description: 'Filter by board name or ID',
    }),
    limit: Flags.integer({
      char: 'l',
      description: 'Maximum number of sessions to show',
      default: 50,
    }),
  };

  /**
   * Format relative time (e.g., "2 mins ago")
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

  /**
   * Format status with color
   */
  private formatStatus(status: Session['status']): string {
    const icons = {
      running: chalk.blue('●'),
      stopping: chalk.yellow('◐'),
      awaiting_permission: chalk.yellow('⏸'),
      completed: chalk.green('✓'),
      failed: chalk.red('✗'),
      idle: chalk.gray('○'),
    };

    const labels = {
      running: chalk.blue('Running'),
      stopping: chalk.yellow('Stopping'),
      awaiting_permission: chalk.yellow('Awaiting Permission'),
      completed: chalk.green('Done'),
      failed: chalk.red('Failed'),
      idle: chalk.gray('Idle'),
    };

    return `${icons[status]} ${labels[status]}`;
  }

  /**
   * Truncate text to max length
   */
  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 3)}...`;
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(SessionList);

    // Connect to daemon (auto-checks if running)
    const client = await this.connectToDaemon();

    try {
      // Build query
      interface QueryParams {
        $limit: number;
        $sort: { created_at: -1 };
        status?: string;
        agentic_tool?: string;
        board_id?: string;
      }

      const query: QueryParams = {
        $limit: flags.limit,
        $sort: { created_at: -1 }, // Most recent first
      };

      if (flags.status) query.status = flags.status;
      if (flags.agent) query.agentic_tool = flags.agent;
      if (flags.board) query.board_id = flags.board; // TODO: Support board name lookup

      // Fetch sessions
      const sessionsService = client.service('sessions');
      const result = await sessionsService.find({ query });
      const isPaginated = !Array.isArray(result);
      const sessions = Array.isArray(result) ? result : (result as Paginated<Session>).data;
      const total = isPaginated ? (result as Paginated<Session>).total : sessions.length;

      if (!Array.isArray(sessions) || sessions.length === 0) {
        this.log(chalk.dim('No sessions found.'));
        this.log('');
        this.log(`Create one with: ${chalk.cyan('agor session create')}`);
        return;
      }

      // Create table
      const table = new Table({
        head: [
          chalk.cyan('ID'),
          chalk.cyan('Description'),
          chalk.cyan('Agent'),
          chalk.cyan('Status'),
          chalk.cyan('Tasks'),
          chalk.cyan('Worktree'),
          chalk.cyan('Git Ref'),
          chalk.cyan('Modified'),
        ],
        style: {
          head: [],
          border: ['dim'],
        },
        colWidths: [10, 30, 13, 12, 8, 18, 15, 12],
      });

      // Add rows
      for (const session of sessions) {
        const shortId = formatShortId(session.session_id);
        const _firstTask =
          Array.isArray(session.tasks) && session.tasks.length > 0 ? session.tasks[0] : null;
        const description = this.truncate(session.description || '(no description)', 28);
        const taskCount = session.tasks?.length || 0;
        // Note: session.tasks are TaskID arrays, not full Task objects in list view
        // Task completion stats would require joining with tasks table
        const completedTasks = 0;
        // Note: Session now uses worktree_id, not nested repo object
        // For now, show worktree_id if available, otherwise '-'
        const worktree = session.worktree_id ? session.worktree_id.substring(0, 8) : '-';
        const gitRef = session.git_state?.ref || '-';
        const modified = this.formatRelativeTime(session.last_updated || session.created_at);

        table.push([
          chalk.dim(shortId),
          description,
          session.agentic_tool,
          this.formatStatus(session.status),
          `${completedTasks}/${taskCount}`,
          chalk.dim(worktree),
          chalk.dim(gitRef),
          chalk.dim(modified),
        ]);
      }

      // Display
      this.log('');
      this.log(table.toString());
      this.log('');
      if (isPaginated && total > sessions.length) {
        this.log(chalk.dim(`Showing ${sessions.length} of ${total} session(s)`));
      } else {
        this.log(chalk.dim(`Showing ${sessions.length} session(s)`));
      }
      this.log('');

      // Cleanup client connection
      await this.cleanupClient(client);
      process.exit(0);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to fetch sessions: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
