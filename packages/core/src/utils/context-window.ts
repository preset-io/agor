/**
 * Context Window Utilities
 *
 * DEPRECATED: This file contains legacy utilities and outdated documentation.
 *
 * Current approach (as of Jan 2025):
 * - Context window is computed per-tool via tool.computeContextWindow()
 * - For Claude Code: Sum input+output tokens across tasks since last compaction
 * - For Codex/Gemini: Use latest task's SDK-reported cumulative value
 * - Stored in Task.computed_context_window for efficient access
 *
 * See:
 * - packages/core/src/tools/base/tool.interface.ts (computeContextWindow interface)
 * - packages/core/src/tools/claude/claude-tool.ts (implementation)
 * - packages/core/src/tools/claude/normalizer.ts (per-task normalization)
 */

// No imports needed - legacy file, all code removed
