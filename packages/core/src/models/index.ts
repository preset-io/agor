/**
 * Model metadata exports
 *
 * Browser-safe model constants and types for UI components.
 * No SDK dependencies - just data structures.
 */

// Claude models
export * from './claude.js';

// Codex models
export * from './codex.js';

// Copilot models
export * from './copilot.js';

// Gemini models
export * from './gemini.js';
// Soft validation: does a model ID look like it belongs to its agentic tool?
export * from './lint-model-tool-match.js';
// Model config normalization (shared across session-creation paths)
export * from './resolve-config.js';
