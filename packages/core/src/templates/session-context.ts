/**
 * Static Agor System Prompt Loader
 *
 * Used by SDK handlers to append the same Agor orientation text on every turn.
 * Apart from the minimal execution identity block below, dynamic context belongs
 * in Agor MCP tools (especially agor_sessions_get_current_context), so provider
 * prompt prefixes remain stable for server-side caching.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionID } from '../types/id';
import { renderTemplate } from './handlebars-helpers';

/**
 * Load Agor system prompt template from disk
 */
export async function loadAgorSystemPromptTemplate(): Promise<string> {
  const templatePath = path.join(__dirname, 'agor-system-prompt.md');
  return await fs.readFile(templatePath, 'utf-8');
}

/**
 * Render the static Agor system prompt.
 *
 * This intentionally does not accept session/repo dependencies. Agents should
 * fetch live Agor context through MCP instead of embedding dynamic values here.
 *
 * The rendered prompt is static for the life of the process, so the disk read
 * and render happen once and the result is shared by every tool and turn.
 */
let cachedPrompt: Promise<string> | undefined;

export function renderAgorSystemPrompt(): Promise<string> {
  cachedPrompt ??= loadAgorSystemPromptTemplate()
    .then((template) => renderTemplate(template, {}))
    .catch((error) => {
      cachedPrompt = undefined;
      throw error;
    });
  return cachedPrompt;
}

/**
 * Runtime-supplied execution identity for the current provider request. Keep this
 * separate from the cached static orientation: forked/resumed SDK histories can
 * retain old instructions, and workspace files are shared by multiple Agor sessions.
 *
 * Pass the admitted execution's Agor ID, never an SDK thread ID or an ID recovered
 * from conversation text. No ancestry lookup, credentials, or per-turn metadata.
 * This is model guidance, not authenticated text: other content can imitate the
 * block, especially in a user turn. Destination permission checks, not this label
 * or an unvalidated nonce, remain the authorization boundary.
 */
export function renderAgorSessionIdentity(sessionId: SessionID): string {
  return `<agor_session_identity>
Current Agor session ID: ${sessionId} (runtime-supplied)
This is the current caller, not a fork source, spawn parent, or provider SDK thread ID.
Inherited conversation and workspace IDs may be stale; do not use them as your current identity. For callbacks to this session, use enableCallback:true and omit callbackSessionId. Intentional authorized alternate callbackSessionId targets remain supported.
</agor_session_identity>`;
}
