/**
 * Policy for which tool calls should land expanded by default in the
 * conversation UI. Most tools stay collapsed so the chain reads as a
 * scannable list of headers; a small set whose body IS the point of the
 * call (file writes) are promoted.
 *
 * Keep this set in sync with the tool renderer registry
 * (`ToolUseRenderer/renderers/index.ts`) when adding cross-agent equivalents.
 */

/**
 * Tool names whose ToolBlock body is the primary payload of the call
 * (i.e. you almost always want to see it without a click). In practice
 * that's file writes / edits, where the diff IS the content.
 *
 * Includes cross-agent equivalents:
 * - Claude Code: `Write`, `Edit`, `MultiEdit`, `NotebookEdit`
 * - Codex: `edit_files`
 */
const TOOLS_EXPANDED_BY_DEFAULT = new Set<string>([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'edit_files',
]);

/**
 * Whether a tool call should render its ToolBlock body expanded by default.
 */
export function shouldExpandToolByDefault(toolName: string): boolean {
  return TOOLS_EXPANDED_BY_DEFAULT.has(toolName);
}
