/**
 * Static Agor System Prompt Loader
 *
 * Used by SDK handlers to append the same Agor orientation text on every turn.
 * Dynamic session/branch/repo/board context belongs in Agor MCP tools, especially
 * agor_sessions_get_current_context, so provider-visible prompt prefixes remain
 * stable for server-side prompt caching.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
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
 */
export async function renderAgorSystemPrompt(): Promise<string> {
  const template = await loadAgorSystemPromptTemplate();
  return renderTemplate(template, {});
}
