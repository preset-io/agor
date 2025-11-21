/**
 * Load Claude Code session by parsing transcript file
 *
 * Strategy:
 * 1. Locate transcript file in ~/.claude/projects/{project-slug}/{session-id}.jsonl
 * 2. Parse the JSONL file to get full message history
 */

import { getTranscriptPath, parseTranscript, type TranscriptMessage } from './transcript-parser';

export interface ClaudeSession {
  sessionId: string;
  transcriptPath: string;
  cwd: string | null;
  messages: TranscriptMessage[];
}

/**
 * Load a Claude Code session by ID
 *
 * Parses the JSONL transcript file from ~/.claude/projects/
 */
export async function loadClaudeSession(
  sessionId: string,
  projectDir?: string
): Promise<ClaudeSession> {
  // Get transcript path
  const transcriptPath = getTranscriptPath(sessionId, projectDir);

  // Parse the transcript file
  const messages = await parseTranscript(transcriptPath);

  // Extract cwd from first message with cwd field
  const cwdMessage = messages.find((msg) => msg.cwd);
  const cwd = cwdMessage?.cwd || null;

  return {
    sessionId,
    transcriptPath,
    cwd,
    messages,
  };
}
