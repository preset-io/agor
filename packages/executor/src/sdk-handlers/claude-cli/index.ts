/**
 * Executor-side adapter for the Claude Code CLI agentic tool.
 *
 * The "runtime" is the `claude` binary running interactively in a Zellij
 * pane — there is no in-process loop here. All the pure utilities the
 * adapter needs (spawn argv builder, JSONL event translator, path slug)
 * live in `@agor/core/claude-cli` so both daemon and executor can use
 * them; this file is currently just a marker for the directory's place
 * in the executor's adapter layout.
 *
 * Re-exporting the core surface here is intentionally avoided because the
 * executor build currently does NOT depend on the core's claude-cli
 * subpath at TS-resolution time, and adding a re-export here would force
 * a build-order coupling we don't need.
 */
export {};
