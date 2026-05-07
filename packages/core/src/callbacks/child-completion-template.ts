/**
 * Child-session completion callback template.
 *
 * Variables available:
 * - childSessionId: Short ID of completed child session
 * - childSessionFullId: Full UUIDv7 of child session
 * - childTaskId: Short ID of completed task
 * - childTaskFullId: Full UUIDv7 of task
 * - parentSessionId: Short ID of callback target session (alias: callbackSessionId)
 * - spawnPrompt: Original prompt given to child
 * - status: Task status (COMPLETED, FAILED, etc.)
 * - completedAt: ISO timestamp of completion
 * - messageCount: Number of messages in completed task
 * - toolUseCount: Number of tools used
 * - lastAssistantMessage: Child's final assistant message content (optional)
 *
 * Renders via the shared `renderTemplate` helper in
 * `@agor/core/templates/handlebars-helpers` — no separate Handlebars
 * instance, no per-module helper registration. The `eq` helper is part of
 * the shared registry.
 */

import { renderTemplate } from '../templates/handlebars-helpers';

const DEFAULT_TEMPLATE = `[Agor] Child session {{childSessionId}} has {{#if (eq status "completed")}}completed{{else}}failed{{/if}}.

{{#if spawnPrompt}}**Task:** {{spawnPrompt}}
{{/if}}**Status:** {{status}}
**Stats:** {{messageCount}} messages, {{toolUseCount}} tool uses

{{#if lastAssistantMessage}}**Result:**
{{lastAssistantMessage}}

{{/if}}{{#if (eq status "completed")}}Use \`agor_tasks_get\` (taskId: "{{childTaskFullId}}") or \`agor_sessions_get\` (sessionId: "{{childSessionFullId}}") for more details.{{else}}Investigate the failure using \`agor_tasks_get\` (taskId: "{{childTaskFullId}}") or \`agor_sessions_get\` (sessionId: "{{childSessionFullId}}").

Review what went wrong and decide whether to retry or take a different approach.{{/if}}`;

export interface ChildCompletionContext {
  childSessionId: string; // Short ID (first 8 chars)
  childSessionFullId: string; // Full UUIDv7
  childTaskId: string; // Short ID of completed task
  childTaskFullId: string; // Full UUIDv7 of task
  parentSessionId: string; // Short ID of callback target (kept for backward compat)
  callbackSessionId: string; // Alias: Short ID of callback target session
  spawnPrompt?: string; // Original prompt from spawn (truncated to 120 chars, optional based on include_original_prompt)
  status: string; // Task status (COMPLETED, FAILED, etc.)
  completedAt: string; // ISO timestamp
  messageCount: number;
  toolUseCount: number;
  lastAssistantMessage?: string; // Child's final assistant message content
}

/**
 * Render callback message for parent session.
 *
 * If `customTemplate` is supplied and renders to empty (e.g. helper error),
 * falls back to the default template so the callback never sends an empty
 * message.
 */
export function renderChildCompletionCallback(
  context: ChildCompletionContext,
  customTemplate?: string
): string {
  const ctx = context as unknown as Record<string, unknown>;
  if (customTemplate) {
    const rendered = renderTemplate(customTemplate, ctx);
    if (rendered) return rendered;
  }
  return renderTemplate(DEFAULT_TEMPLATE, ctx);
}
