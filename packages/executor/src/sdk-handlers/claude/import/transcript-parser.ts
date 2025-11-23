/**
 * Claude Code transcript parser
 *
 * Parses JSONL transcript files from ~/.claude/projects/
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

// Transcript message types
export interface TranscriptMessage {
  type: 'user' | 'assistant' | 'system' | 'file-history-snapshot';
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  parentUuid?: string | null;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  message?: {
    role: string;
    content: string | Array<{ type: string; [key: string]: unknown }>;
  };
  isMeta?: boolean;
  isSidechain?: boolean;
  // file-history-snapshot specific
  messageId?: string;
  snapshot?: unknown;
  isSnapshotUpdate?: boolean;
}

/**
 * Get transcript file path for a session ID
 */
export function getTranscriptPath(sessionId: string, projectDir?: string): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (!homeDir) {
    throw new Error('Could not determine home directory');
  }

  // Default to current working directory if not specified
  const cwd = projectDir || process.cwd();

  // Claude Code creates project directories with escaped slashes
  // Example: /Users/max/code/agor → -Users-max-code-agor
  const projectSlug = cwd.replace(/\//g, '-').replace(/\\/g, '-');

  const transcriptPath = path.join(
    homeDir,
    '.claude',
    'projects',
    projectSlug,
    `${sessionId}.jsonl`
  );

  return transcriptPath;
}

/**
 * Parse JSONL transcript file
 */
export async function parseTranscript(transcriptPath: string): Promise<TranscriptMessage[]> {
  if (!fs.existsSync(transcriptPath)) {
    throw new Error(`Transcript file not found: ${transcriptPath}`);
  }

  const messages: TranscriptMessage[] = [];
  const fileStream = fs.createReadStream(transcriptPath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const message = JSON.parse(line) as TranscriptMessage;
      messages.push(message);
    } catch (error) {
      console.error(`Failed to parse line: ${line.substring(0, 100)}...`);
      throw error;
    }
  }

  return messages;
}

/**
 * Load transcript for a session ID
 */
export async function loadSessionTranscript(
  sessionId: string,
  projectDir?: string
): Promise<TranscriptMessage[]> {
  const transcriptPath = getTranscriptPath(sessionId, projectDir);
  return parseTranscript(transcriptPath);
}

/**
 * Filter transcript messages (exclude meta messages, snapshots, etc.)
 */
export function filterConversationMessages(messages: TranscriptMessage[]): TranscriptMessage[] {
  return messages.filter((msg) => {
    // Exclude file history snapshots
    if (msg.type === 'file-history-snapshot') return false;

    // Exclude meta messages (like local command wrappers)
    if (msg.isMeta) return false;

    // Exclude tool result messages (these are internal, not user prompts)
    const content = msg.message?.content;
    if (Array.isArray(content) && content.some((c) => c.type === 'tool_result')) {
      return false;
    }

    // Exclude command execution metadata (XML-wrapped commands)
    if (typeof content === 'string') {
      // Filter out <command-name>, <local-command-stdout>, etc.
      if (content.trim().match(/^<(command-name|local-command-stdout|system-reminder)/)) {
        return false;
      }
    }

    // Include user and assistant messages
    return msg.type === 'user' || msg.type === 'assistant';
  });
}

/**
 * Build conversation tree from transcript messages
 */
export interface ConversationNode {
  message: TranscriptMessage;
  children: ConversationNode[];
}

export function buildConversationTree(messages: TranscriptMessage[]): ConversationNode[] {
  const messageMap = new Map<string, ConversationNode>();
  const roots: ConversationNode[] = [];

  // Create nodes
  for (const message of messages) {
    if (!message.uuid) continue;

    const node: ConversationNode = {
      message,
      children: [],
    };

    messageMap.set(message.uuid, node);
  }

  // Build tree
  for (const message of messages) {
    if (!message.uuid) continue;

    const node = messageMap.get(message.uuid);
    if (!node) continue;

    if (!message.parentUuid) {
      // Root node
      roots.push(node);
    } else {
      // Child node
      const parent = messageMap.get(message.parentUuid);
      if (parent) {
        parent.children.push(node);
      } else {
        // Parent not found, treat as root
        roots.push(node);
      }
    }
  }

  return roots;
}
