/**
 * Auto-title heuristic — derives a short session title from a user's first
 * prompt, with no LLM call.
 *
 * Used by the daemon's task-completion hook ({@link TasksService.patch})
 * when a session's first task finishes and the session still has no
 * explicit title: cheap, synchronous, and tool-agnostic (works the same for
 * every agentic tool, since it only reads the prompt text already stored on
 * the task — see `Task.full_prompt`).
 */

const MAX_TITLE_LENGTH = 60;

export function deriveTitleFromPrompt(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  if (collapsed.length <= MAX_TITLE_LENGTH) return collapsed;

  const truncated = collapsed.slice(0, MAX_TITLE_LENGTH);
  const lastSpace = truncated.lastIndexOf(' ');
  // Only break on a word boundary if it doesn't throw away most of the
  // budget (e.g. one very long leading word) — otherwise just hard-cut.
  const cut = lastSpace > MAX_TITLE_LENGTH * 0.4 ? truncated.slice(0, lastSpace) : truncated;
  return `${cut}…`;
}
