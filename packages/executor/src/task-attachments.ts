import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Task, TaskAttachment } from '@agor/core/types';
import type { AgorClient } from './services/feathers-client.js';

export interface MaterializedTaskPrompt {
  /** Prompt persisted on the task and shown to the user. */
  userPrompt: string;
  /** Executor-only prompt containing paths owned by this executor. */
  executionPrompt: string;
}

function safeLocalFilename(attachment: TaskAttachment, index: number): string {
  const basename = path.basename(attachment.filename.replaceAll('\\', '/'));
  const sanitized =
    Array.from(basename, (character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? '_' : character;
    })
      .join('')
      .slice(0, 200) || 'attachment';
  return `${String(index + 1).padStart(2, '0')}-${sanitized}`;
}

function withAttachmentPaths(prompt: string, localPaths: string[]): string {
  if (localPaths.length === 0) return prompt;
  const block = ['Attached files:', ...localPaths.map((localPath) => `- ${localPath}`)].join('\n');
  if (prompt.trimStart().startsWith('/')) return `${prompt}\n\n${block}`;
  return prompt ? `${block}\n\n${prompt}` : block;
}

function assertCurrentTask(task: Task, sessionId: string, taskId: string): TaskAttachment[] {
  if (task.task_id !== taskId || task.session_id !== sessionId) {
    throw new Error('daemon returned a task outside the executor token scope');
  }
  const attachments = task.metadata?.attachments ?? [];
  if (
    !Array.isArray(attachments) ||
    attachments.some(
      (attachment) =>
        !attachment ||
        typeof attachment.storage_key !== 'string' ||
        typeof attachment.filename !== 'string' ||
        typeof attachment.mime_type !== 'string'
    )
  ) {
    throw new Error('daemon returned invalid task attachment metadata');
  }
  return attachments;
}

/**
 * Retrieve the current task's daemon-owned attachments with its executor JWT,
 * copy them into executor-owned task storage, and derive the private execution
 * prompt. Any missing or invalid byte fails the whole turn.
 */
export async function materializeTaskAttachments(args: {
  client: AgorClient;
  daemonUrl: string;
  sessionToken: string;
  sessionId: string;
  taskId: string;
  prompt: string;
  fetchImpl?: typeof fetch;
  storageRoot?: string;
}): Promise<MaterializedTaskPrompt> {
  const task = await args.client.service('tasks').get(args.taskId);
  const attachments = assertCurrentTask(task, args.sessionId, args.taskId);
  if (attachments.length === 0) {
    return { userPrompt: task.full_prompt, executionPrompt: args.prompt };
  }

  const fetchImpl = args.fetchImpl ?? fetch;
  const storageRoot = args.storageRoot ?? path.join(os.homedir(), '.agor', 'task-attachments');
  await fs.mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const taskDirectory = await fs.mkdtemp(path.join(storageRoot, `${args.taskId}-`));
  const localPaths: string[] = [];

  try {
    for (const [index, attachment] of attachments.entries()) {
      const url = new URL(
        `/sessions/${encodeURIComponent(args.sessionId)}/tasks/${encodeURIComponent(
          args.taskId
        )}/attachments/${index}`,
        args.daemonUrl
      );
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${args.sessionToken}` },
      });
      if (!response.ok) {
        throw new Error(`attachment ${index + 1} retrieval returned HTTP ${response.status}`);
      }
      const responseMime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (responseMime !== attachment.mime_type) {
        throw new Error(`attachment ${index + 1} returned an unexpected MIME type`);
      }

      const localPath = path.join(taskDirectory, safeLocalFilename(attachment, index));
      await fs.writeFile(localPath, Buffer.from(await response.arrayBuffer()), {
        flag: 'wx',
        mode: 0o600,
      });
      localPaths.push(localPath);
    }
  } catch (error) {
    await fs.rm(taskDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(
      `Failed to materialize task attachments: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return {
    userPrompt: task.full_prompt,
    executionPrompt: withAttachmentPaths(args.prompt, localPaths),
  };
}
