/**
 * Session Context Injection
 *
 * Appends Agor-specific context to CLAUDE.md for session awareness.
 * IMPORTANT: Appends to existing CLAUDE.md, does not replace it.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionID } from '@agor/core/types';

/**
 * Generate Agor session context block to append to CLAUDE.md
 *
 * @param sessionId - Agor session ID (internal tracking)
 * @param sdkSessionId - Claude SDK session ID (for conversation continuity, optional)
 */
export function generateSessionContext(sessionId: SessionID, sdkSessionId?: string): string {
  const shortId = sessionId.substring(0, 8);

  let sdkSessionLine = '';
  if (sdkSessionId) {
    sdkSessionLine = `\n- **Claude SDK Session ID:** \`${sdkSessionId}\` (used by Claude CLI for conversation continuity)`;
  }

  return `

---

## Agor Session Context

You are currently running within **Agor** (https://agor.live), a multiplayer canvas for orchestrating AI coding agents.

**Session IDs:**
- **Agor Session ID:** \`${sessionId}\` (short: \`${shortId}\`) - Agor's internal session tracking${sdkSessionLine}

When you see these IDs referenced in prompts or tool calls, they refer to THIS session you're currently in.

For more information about Agor, visit https://agor.live
`;
}

/**
 * Append session context to CLAUDE.md in a worktree
 *
 * CRITICAL: This APPENDS to existing CLAUDE.md, never replaces it!
 * This ensures we don't overwrite the Claude Code system prompt.
 *
 * @param worktreePath - Path to the worktree directory
 * @param sessionId - Agor session ID
 * @param sdkSessionId - Claude SDK session ID (optional, for conversation continuity)
 */
export async function appendSessionContextToCLAUDEmd(
  worktreePath: string,
  sessionId: SessionID,
  sdkSessionId?: string
): Promise<void> {
  const claudeMdPath = path.join(worktreePath, 'CLAUDE.md');

  try {
    // Read existing CLAUDE.md
    let existingContent = '';
    try {
      existingContent = await fs.readFile(claudeMdPath, 'utf-8');
    } catch (_readError) {
      // File doesn't exist - that's ok, we'll create it
      console.log(`📝 CLAUDE.md doesn't exist at ${claudeMdPath}, will create it`);
    }

    // Check if session context already appended (idempotent)
    if (existingContent.includes('## Agor Session Context')) {
      console.log(`✅ Session context already in CLAUDE.md, skipping append`);
      return;
    }

    // Append session context
    const sessionContext = generateSessionContext(sessionId, sdkSessionId);
    const newContent = existingContent + sessionContext;

    await fs.writeFile(claudeMdPath, newContent, 'utf-8');
    console.log(
      `✅ Appended session context to CLAUDE.md for session ${sessionId.substring(0, 8)}`
    );
  } catch (error) {
    console.error(`❌ Failed to append session context to CLAUDE.md:`, error);
    // Non-fatal - agent will still work, just won't know its session ID
  }
}

/**
 * Remove session context from CLAUDE.md (cleanup)
 */
export async function removeSessionContextFromCLAUDEmd(worktreePath: string): Promise<void> {
  const claudeMdPath = path.join(worktreePath, 'CLAUDE.md');

  try {
    const content = await fs.readFile(claudeMdPath, 'utf-8');

    // Remove everything from "## Agor Session Context" onwards
    const contextStart = content.indexOf('\n\n---\n\n## Agor Session Context');
    if (contextStart === -1) {
      return; // No context to remove
    }

    const cleanedContent = content.substring(0, contextStart);
    await fs.writeFile(claudeMdPath, cleanedContent, 'utf-8');
    console.log(`✅ Removed session context from CLAUDE.md`);
  } catch (error) {
    console.error(`❌ Failed to remove session context from CLAUDE.md:`, error);
  }
}
