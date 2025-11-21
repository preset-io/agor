/**
 * `agor session load-claude <session-id>` - Load Claude Code session into Agor
 *
 * Imports a Claude Code session by parsing the transcript file and creating
 * a corresponding Agor session with tasks.
 */

import path from 'node:path';
import {
  extractTasksFromMessages,
  filterConversationMessages,
  loadClaudeSession,
  transcriptsToMessages,
} from '@agor/core/claude';
import { generateId } from '@agor/core/db';
import type {
  MessageID,
  Repo,
  Session,
  SessionID,
  TaskID,
  UUID,
  Worktree,
  WorktreeID,
} from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';

export default class SessionLoadClaude extends BaseCommand {
  static description = 'Load a local Claude Code session into Agor';

  static examples = [
    '<%= config.bin %> <%= command.id %> <session-id>',
    '<%= config.bin %> <%= command.id %> 34e94925-f4cc-4685-8869-83c77062ad14',
  ];

  static args = {
    sessionId: Args.string({
      description: 'Claude Code session ID to load',
      required: true,
    }),
  };

  static flags = {
    'project-dir': Flags.string({
      description: 'Project directory (defaults to current directory)',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SessionLoadClaude);

    const sessionId = args.sessionId as string;
    const projectDir = flags['project-dir'] || process.cwd();

    const client = await this.connectToDaemon();

    try {
      this.log(`\n${chalk.blue('●')} Loading Claude Code session: ${chalk.cyan(sessionId)}\n`);

      // Load session transcript
      const claudeSession = await loadClaudeSession(sessionId, projectDir);

      this.log(`${chalk.green('✓')} Parsed transcript: ${claudeSession.messages.length} messages`);

      // Filter to conversation messages
      const conversation = filterConversationMessages(claudeSession.messages);
      this.log(
        `${chalk.green('✓')} Conversation: ${conversation.length} messages (${conversation.filter((m) => m.type === 'user').length} user, ${conversation.filter((m) => m.type === 'assistant').length} assistant)`
      );

      // Extract first user message as description
      const firstUserMessage = conversation.find((m) => m.type === 'user');
      const description = firstUserMessage?.message?.content
        ? typeof firstUserMessage.message.content === 'string'
          ? firstUserMessage.message.content.substring(0, 200)
          : JSON.stringify(firstUserMessage.message.content).substring(0, 200)
        : 'Imported Claude Code session';

      // Create or find repo for the project directory
      this.log(`${chalk.blue('●')} Setting up worktree for imported session...`);
      const reposService = client.service('repos');
      const absoluteProjectDir = path.resolve(projectDir);
      const projectName = path.basename(absoluteProjectDir);

      // Try to find existing repo by path
      let repo: { repo_id: UUID; slug: string } | null = null;
      try {
        const allRepos = await reposService.find({ query: { $limit: 1000 } });
        const reposList = Array.isArray(allRepos) ? allRepos : allRepos.data;
        repo = reposList.find((r: Repo) => r.local_path === absoluteProjectDir) || null;
      } catch {
        // Ignore errors
      }

      // Create repo if it doesn't exist
      if (!repo) {
        const newRepo = (await client.service('repos/local').create({
          path: absoluteProjectDir,
          slug: `imported-${projectName}`,
        })) as Repo;
        repo = { repo_id: newRepo.repo_id, slug: newRepo.slug };
        this.log(`${chalk.green('✓')} Created repo: ${chalk.cyan(repo.slug)}`);
      } else {
        this.log(`${chalk.green('✓')} Found existing repo: ${chalk.cyan(repo.slug)}`);
      }

      // Create worktree for this imported session
      const worktreesService = client.service('worktrees');
      const worktreeName = `imported-${sessionId.substring(0, 8)}`;
      const worktree = (await worktreesService.create({
        worktree_id: generateId() as WorktreeID,
        repo_id: repo.repo_id,
        name: worktreeName,
        ref: 'unknown', // Claude sessions don't track git state
        worktree_unique_id: 0, // Will be auto-assigned by service hook
        path: absoluteProjectDir,
        new_branch: false,
        last_used: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        created_by: 'cli-import' as UUID,
      })) as Worktree;
      this.log(`${chalk.green('✓')} Created worktree: ${chalk.cyan(worktreeName)}`);

      // Create Agor session
      const agorSession: Partial<Session> & { session_id: SessionID; created_by: string } = {
        session_id: generateId() as SessionID,
        agentic_tool: 'claude-code',
        status: TaskStatus.COMPLETED,
        description: description,
        created_at: new Date().toISOString(),
        last_updated: new Date().toISOString(),
        created_by: 'cli-import',
        worktree_id: worktree.worktree_id,
        git_state: {
          ref: 'unknown',
          base_sha: '',
          current_sha: '',
        },
        genealogy: {
          children: [],
        },
        tasks: [],
        message_count: conversation.length,
      };

      // Create session in daemon
      const sessionsService = client.service('sessions');
      const created = await sessionsService.create(agorSession);

      this.log(`${chalk.green('✓')} Created Agor session: ${chalk.cyan(created.session_id)}`);

      // Convert transcript messages to Agor messages
      const messages = transcriptsToMessages(conversation, created.session_id);
      this.log(`${chalk.blue('●')} Converting ${messages.length} messages...`);

      // Bulk insert messages in batches to avoid timeout
      const messagesBulkService = client.service('messages/bulk');
      const batchSize = 100;
      const totalMessages = messages.length;

      for (let i = 0; i < totalMessages; i += batchSize) {
        const end = Math.min(i + batchSize, totalMessages);
        const batch = messages.slice(i, end);

        await messagesBulkService.createMany(batch);

        this.log(`${chalk.blue('●')} Processed ${end}/${totalMessages} messages...`);
      }

      this.log(`${chalk.green('✓')} Saved ${totalMessages} messages to database`);

      // Extract tasks from user messages
      const tasks = extractTasksFromMessages(messages, created.session_id);
      this.log(`${chalk.blue('●')} Extracting ${tasks.length} tasks from user messages...`);

      // Bulk insert tasks in batches
      const tasksBulkService = client.service('tasks/bulk');
      const taskBatchSize = 100;
      const totalTasks = tasks.length;
      const createdTasks = [];

      for (let i = 0; i < totalTasks; i += taskBatchSize) {
        const end = Math.min(i + taskBatchSize, totalTasks);
        const batch = tasks.slice(i, end);

        const batchResult = await tasksBulkService.createMany(batch);
        createdTasks.push(...batchResult);

        this.log(`${chalk.blue('●')} Created ${end}/${totalTasks} tasks...`);
      }

      this.log(`${chalk.green('✓')} Created ${totalTasks} tasks`);

      // Update session with task IDs
      const taskIds = createdTasks.map((t) => t.task_id);
      await sessionsService.patch(created.session_id, {
        tasks: taskIds,
      });

      // Link messages to their tasks based on message_range
      this.log(`${chalk.blue('●')} Linking messages to tasks...`);
      let linkedCount = 0;

      // Batch updates by collecting message_id -> task_id mappings
      const messageLinkUpdates: Array<{ messageId: MessageID; taskId: TaskID }> = [];

      for (const task of createdTasks) {
        const { start_index, end_index } = task.message_range;

        // Collect all messages in this range
        for (let idx = start_index; idx <= end_index; idx++) {
          const message = messages[idx];
          if (message) {
            messageLinkUpdates.push({
              messageId: message.message_id,
              taskId: task.task_id,
            });
            linkedCount++;
          }
        }
      }

      // Use bulk link service if available, otherwise fall back to individual updates
      try {
        const messageLinkService = client.service('messages/link-tasks');
        await messageLinkService.create({ updates: messageLinkUpdates });
      } catch {
        // Fallback: batch patch in groups of 100
        const messagesService = client.service('messages');
        const batchSize = 100;
        for (let i = 0; i < messageLinkUpdates.length; i += batchSize) {
          const batch = messageLinkUpdates.slice(i, i + batchSize);
          await Promise.all(
            batch.map((update) =>
              messagesService.patch(update.messageId, { task_id: update.taskId })
            )
          );
          this.log(
            `${chalk.blue('●')} Linked ${Math.min(i + batchSize, messageLinkUpdates.length)}/${messageLinkUpdates.length} messages...`
          );
        }
      }

      this.log(
        `${chalk.green('✓')} Linked ${linkedCount} messages to ${createdTasks.length} tasks`
      );

      this.log(`\n${chalk.green('✓')} Successfully imported session!\n`);
      this.log(`View with: ${chalk.cyan(`agor session show ${created.session_id}`)}`);
      this.log('');

      await this.cleanupClient(client);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to load session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
