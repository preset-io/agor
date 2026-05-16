/**
 * Path helpers for the Claude Code CLI on-disk session storage.
 *
 * The `claude` binary writes each session's transcript to:
 *
 *   ~/.claude/projects/<slug>/<session-id>.jsonl
 *
 * `<slug>` is the working directory the session was launched from, with every
 * `/` and `.` replaced by `-`. This rule was verified live on
 * `claude` v2.1.132 against multiple paths.
 *
 * See docs/internal/claude-code-cli-integration-analysis-2026-05-14.md
 * (Appendix A) for the live session sample these helpers were validated
 * against.
 */

import path from 'node:path';

/**
 * Slug a working-directory path the way the `claude` CLI does.
 *
 * Replaces every `/` and `.` with `-`. The path is NOT lowercased — the slug
 * preserves case so we can round-trip back to the absolute path if needed.
 *
 * Examples:
 *
 *   /Users/max/projects/agor       → -Users-max-projects-agor
 *   /home/agor/.agor/repos/agor    → -home-agor--agor-repos-agor
 *   /tmp/foo.bar/baz               → -tmp-foo-bar-baz
 *
 * Note the `.agor` directory: the leading dot becomes `-` and the
 * surrounding `/` separators also become `-`, producing the `--` doubling.
 * This matches Anthropic's slug rule exactly.
 */
export function slugForCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

/**
 * Compute the directory under `~/.claude/projects/` for a given working dir.
 *
 * The directory exists as soon as the first session for that cwd has written
 * any data, but we never create it ourselves — the CLI does.
 */
export function claudeProjectDir(homeDir: string, cwd: string): { slug: string; dir: string } {
  const slug = slugForCwd(cwd);
  return {
    slug,
    dir: path.join(homeDir, '.claude', 'projects', slug),
  };
}

/**
 * Compute the absolute path of a session's JSONL transcript.
 *
 * @param homeDir       The Unix user's home directory whose `~/.claude/`
 *                      we're targeting. In `strict` Unix mode this is the
 *                      session owner's home; in `insulated` mode it's the
 *                      shared executor user's home.
 * @param cwd           The cwd the `claude` process was launched from.
 *                      Same value that goes to `--add-dir` / the spawn cwd.
 * @param sessionId     The UUID passed to `claude --session-id <uuid>`.
 */
export function claudeSessionJsonlPath(homeDir: string, cwd: string, sessionId: string): string {
  const { dir } = claudeProjectDir(homeDir, cwd);
  return path.join(dir, `${sessionId}.jsonl`);
}

/**
 * Compute the directory under `<slug>/<sessionId>/subagents/` that holds
 * sub-agent JSONL files for Task() tool internals.
 *
 * Watching this directory (and creating child watchers as `agent-<id>.jsonl`
 * files appear) is how we surface internal Task() sub-agents in the
 * conversation view. See § Subagent JSONL ingestion in the analysis doc.
 */
export function claudeSubagentsDir(homeDir: string, cwd: string, sessionId: string): string {
  const { dir } = claudeProjectDir(homeDir, cwd);
  return path.join(dir, sessionId, 'subagents');
}
