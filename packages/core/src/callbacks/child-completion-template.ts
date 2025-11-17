import Handlebars from 'handlebars';

/**
 * Default template for child session completion callback
 * Variables available:
 * - childSessionId: Short ID of completed child session
 * - childSessionFullId: Full UUIDv7 of child session
 * - childTaskId: Short ID of completed task
 * - childTaskFullId: Full UUIDv7 of task
 * - parentSessionId: Short ID of parent session
 * - spawnPrompt: Original prompt given to child
 * - status: Task status (COMPLETED, FAILED, etc.)
 * - completedAt: ISO timestamp of completion
 * - messageCount: Number of messages in completed task
 * - toolUseCount: Number of tools used
 * - lastAssistantMessage: Child's final assistant message content (optional)
 */
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
  parentSessionId: string; // Short ID of parent
  spawnPrompt?: string; // Original prompt from spawn (truncated to 120 chars, optional based on include_original_prompt)
  status: string; // Task status (COMPLETED, FAILED, etc.)
  completedAt: string; // ISO timestamp
  messageCount: number;
  toolUseCount: number;
  lastAssistantMessage?: string; // Child's final assistant message content
}

/**
 * Register custom Handlebars helpers for templates
 * Note: Check if 'eq' helper already exists in packages/core/src/templates/handlebars-helpers.ts
 */
// biome-ignore lint/suspicious/noExplicitAny: Handlebars helper accepts any comparable value
Handlebars.registerHelper('eq', (a: any, b: any) => a === b);

/**
 * Render callback message for parent session
 */
export function renderChildCompletionCallback(
  context: ChildCompletionContext,
  customTemplate?: string
): string {
  try {
    const template = Handlebars.compile(customTemplate || DEFAULT_TEMPLATE);
    return template(context);
  } catch (error) {
    console.error('❌ Template rendering failed, using default:', error);
    // Fallback to default template if custom template fails
    if (customTemplate) {
      const defaultTemplate = Handlebars.compile(DEFAULT_TEMPLATE);
      return defaultTemplate(context);
    }
    throw error;
  }
}
