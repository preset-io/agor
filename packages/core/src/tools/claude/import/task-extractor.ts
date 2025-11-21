/**
 * Extract Tasks from Claude Code conversation messages
 *
 * Converts user messages into Task records with message ranges.
 */

import { generateId } from '../../../lib/ids';
import type { Message, SessionID, Task, UUID } from '../../../types';
import { TaskStatus } from '../../../types';

export interface ExtractedTask {
  task_id: string;
  session_id: SessionID;
  full_prompt: string;
  description: string;
  status: typeof TaskStatus.COMPLETED;
  message_range: {
    start_index: number;
    end_index: number;
    start_timestamp: string;
    end_timestamp?: string;
  };
  git_state: {
    sha_at_start: string;
  };
  model: string;
  tool_use_count: number;
  created_at: string;
  completed_at?: string;
}

/**
 * Extract tasks from conversation messages
 * Each user message becomes a task with its associated assistant responses
 */
export function extractTasksFromMessages(
  messages: Message[],
  sessionId: SessionID
): Partial<Task>[] {
  const tasks: Partial<Task>[] = [];

  // Find all user messages (these become task boundaries)
  const userMessageIndices = messages
    .map((msg, idx) => (msg.type === 'user' ? idx : -1))
    .filter((idx) => idx !== -1);

  // Create a task for each user message
  for (let i = 0; i < userMessageIndices.length; i++) {
    const startIndex = userMessageIndices[i];
    const userMessage = messages[startIndex];

    // End index is the message before the next user message (or last message)
    const endIndex =
      i < userMessageIndices.length - 1 ? userMessageIndices[i + 1] - 1 : messages.length - 1;

    // Extract message range content preview
    const messagesInRange = messages.slice(startIndex, endIndex + 1);

    // Count tool uses in this range
    const toolUseCount = messagesInRange.reduce((count, msg) => {
      return count + (msg.tool_uses?.length ?? 0);
    }, 0);

    // Get full prompt from user message content
    // Clean up any remaining XML tags or complex payloads
    let fullPrompt = '';
    if (typeof userMessage.content === 'string') {
      fullPrompt = userMessage.content;
    } else if (Array.isArray(userMessage.content)) {
      // If content is an array, extract text content only
      const textContent = userMessage.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text || '')
        .join('\n');
      fullPrompt = textContent || JSON.stringify(userMessage.content);
    } else {
      fullPrompt = JSON.stringify(userMessage.content);
    }

    // Clean up newlines and excessive whitespace for description
    const cleanPrompt = fullPrompt.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

    // Generate short description (first 120 chars)
    const description = cleanPrompt.substring(0, 120) + (cleanPrompt.length > 120 ? '...' : '');

    // Get timestamps
    const startTimestamp = userMessage.timestamp;
    const endMessage = messages[endIndex];
    const endTimestamp = endMessage?.timestamp;

    // Create task
    tasks.push({
      task_id: generateId() as UUID,
      session_id: sessionId,
      full_prompt: fullPrompt,
      description,
      status: TaskStatus.COMPLETED, // Imported sessions are historical
      message_range: {
        start_index: startIndex,
        end_index: endIndex,
        start_timestamp: startTimestamp,
        end_timestamp: endTimestamp,
      },
      git_state: {
        ref_at_start: 'unknown', // No git tracking in Claude Code transcripts
        sha_at_start: 'unknown', // No git tracking in Claude Code transcripts
      },
      model: userMessage.metadata?.model || 'claude-sonnet-4-5',
      tool_use_count: toolUseCount,
      created_at: startTimestamp,
      completed_at: endTimestamp,
    });
  }

  return tasks;
}
