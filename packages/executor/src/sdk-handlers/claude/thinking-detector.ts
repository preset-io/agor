/**
 * Thinking Mode Detection
 *
 * Detects thinking level keywords in user prompts and maps them to token budgets.
 * Matches Claude Code CLI behavior for automatic thinking budget allocation.
 *
 * Keywords hierarchy: think < think hard < think harder < ultrathink
 * Token budgets based on reverse-engineering of Claude Code CLI by Simon Willison.
 */

export type ThinkingLevel = 'none' | 'think' | 'megathink' | 'ultrathink';

export interface ThinkingConfig {
  level: ThinkingLevel;
  tokens: number;
  detectedPhrases: string[];
}

/**
 * Token budgets for each thinking level (from Claude Code CLI)
 * Source: https://goatreview.com/claude-code-thinking-levels-think-ultrathink/
 */
export const THINKING_BUDGETS: Record<ThinkingLevel, number> = {
  none: 0,
  think: 4000, // Basic thinking
  megathink: 10000, // "think hard", "think deeply"
  ultrathink: 31999, // "think harder", "ultrathink"
};

/**
 * Trigger patterns for ultrathink (highest priority)
 * Case-insensitive matching with word boundaries
 */
const ULTRATHINK_PATTERNS = [
  /\bultrathink\b/i,
  /\bthink\s+harder\b/i,
  /\bthink\s+intensely\b/i,
  /\bthink\s+longer\b/i,
  /\bthink\s+super\s+hard\b/i,
  /\bthink\s+very\s+hard\b/i,
  /\bthink\s+really\s+hard\b/i,
];

/**
 * Trigger patterns for megathink (medium priority)
 */
const MEGATHINK_PATTERNS = [
  /\bthink\s+hard\b/i,
  /\bthink\s+deeply\b/i,
  /\bthink\s+more\b/i,
  /\bthink\s+a\s+lot\b/i,
  /\bthink\s+about\s+it\b/i,
];

/**
 * Trigger pattern for basic think (lowest priority)
 * Only matches standalone "think" - other patterns checked first
 */
const THINK_PATTERNS = [/\bthink\b/i];

/**
 * Detect thinking level from user prompt
 *
 * Matches Claude Code CLI behavior:
 * - Checks highest level first (ultrathink → megathink → think)
 * - Returns first match found
 * - Case-insensitive matching
 * - Returns 'none' if no keywords detected
 *
 * @param prompt - User's prompt text
 * @returns Thinking configuration with level, tokens, and detected phrases
 *
 * @example
 * detectThinkingLevel("please ultrathink this problem")
 * // => { level: 'ultrathink', tokens: 31999, detectedPhrases: ['ultrathink'] }
 *
 * @example
 * detectThinkingLevel("think hard about the architecture")
 * // => { level: 'megathink', tokens: 10000, detectedPhrases: ['think hard'] }
 *
 * @example
 * detectThinkingLevel("implement user auth")
 * // => { level: 'none', tokens: 0, detectedPhrases: [] }
 */
export function detectThinkingLevel(prompt: string): ThinkingConfig {
  const detectedPhrases: string[] = [];

  // Check highest level first (ultrathink)
  for (const pattern of ULTRATHINK_PATTERNS) {
    const match = prompt.match(pattern);
    if (match) {
      detectedPhrases.push(match[0]);
      return {
        level: 'ultrathink',
        tokens: THINKING_BUDGETS.ultrathink,
        detectedPhrases,
      };
    }
  }

  // Check medium level (megathink)
  for (const pattern of MEGATHINK_PATTERNS) {
    const match = prompt.match(pattern);
    if (match) {
      detectedPhrases.push(match[0]);
      return {
        level: 'megathink',
        tokens: THINKING_BUDGETS.megathink,
        detectedPhrases,
      };
    }
  }

  // Check basic level (think)
  for (const pattern of THINK_PATTERNS) {
    const match = prompt.match(pattern);
    if (match) {
      detectedPhrases.push(match[0]);
      return {
        level: 'think',
        tokens: THINKING_BUDGETS.think,
        detectedPhrases,
      };
    }
  }

  // No keywords detected
  return {
    level: 'none',
    tokens: 0,
    detectedPhrases: [],
  };
}

/**
 * Resolve final thinking budget based on mode and prompt detection
 *
 * Three modes:
 * - 'off': Always return null (no thinking)
 * - 'manual': Use configured manual token budget
 * - 'auto': Auto-detect from prompt keywords (matches CLI behavior)
 *
 * @param prompt - User's prompt text
 * @param sessionConfig - Session's thinking configuration
 * @returns Token budget to use, or null to disable thinking
 *
 * @example
 * // Auto mode with keywords
 * resolveThinkingBudget("think harder", { thinkingMode: 'auto' })
 * // => 31999
 *
 * @example
 * // Auto mode without keywords (CLI behavior: disable thinking)
 * resolveThinkingBudget("implement feature", { thinkingMode: 'auto' })
 * // => null
 *
 * @example
 * // Manual mode (ignore keywords)
 * resolveThinkingBudget("anything", { thinkingMode: 'manual', manualThinkingTokens: 15000 })
 * // => 15000
 */
export function resolveThinkingBudget(
  prompt: string,
  sessionConfig: {
    thinkingMode?: 'auto' | 'manual' | 'off';
    manualThinkingTokens?: number;
  }
): number | null {
  const mode = sessionConfig.thinkingMode || 'auto';

  switch (mode) {
    case 'off':
      return null; // Disable thinking

    case 'manual':
      return sessionConfig.manualThinkingTokens || null;

    case 'auto': {
      const detected = detectThinkingLevel(prompt);
      // Match Claude Code CLI: only enable thinking when keywords present
      return detected.tokens > 0 ? detected.tokens : null;
    }

    default:
      return null;
  }
}
