/**
 * Claude model metadata re-export
 *
 * Models are defined in @agor/core/models to maintain a single source of truth.
 * This file simply re-exports them for use within the executor package.
 */

export {
  AVAILABLE_CLAUDE_MODEL_ALIASES,
  type ClaudeModel,
  DEFAULT_CLAUDE_MODEL,
} from '@agor/core/models';
