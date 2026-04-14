/**
 * Claude model utilities
 *
 * Handles model ID parsing for features like extended context (1M) that use
 * suffixes on the model ID but map to beta flags in the SDK.
 */

const CONTEXT_1M_BETA = 'context-1m-2025-08-07';
const MODEL_1M_SUFFIX = '[1m]';

/**
 * Parse a model ID that may include a [1m] suffix into the base model ID
 * and any required SDK beta flags.
 *
 * @example
 * parseModelWithBetas('claude-opus-4-6[1m]')
 * // => { model: 'claude-opus-4-6', betas: ['context-1m-2025-08-07'] }
 *
 * parseModelWithBetas('claude-sonnet-4-6')
 * // => { model: 'claude-sonnet-4-6', betas: [] }
 */
export function parseModelWithBetas(rawModel: string): {
  model: string;
  betas: string[];
} {
  if (rawModel.endsWith(MODEL_1M_SUFFIX)) {
    return {
      model: rawModel.slice(0, -MODEL_1M_SUFFIX.length),
      betas: [CONTEXT_1M_BETA],
    };
  }
  return { model: rawModel, betas: [] };
}
