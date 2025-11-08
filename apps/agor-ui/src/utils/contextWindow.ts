/**
 * Context Window Utilities
 *
 * Helpers for calculating and rendering context window progress indicators
 */

/**
 * Get color for context window usage based on percentage
 *
 * @param percentage - Usage percentage (0-100)
 * @returns rgba color string
 */
export function getContextWindowColor(percentage: number): string {
  if (percentage < 50) {
    return 'rgba(82, 196, 26, 0.12)'; // Green
  }
  if (percentage < 80) {
    return 'rgba(250, 173, 20, 0.12)'; // Orange
  }
  return 'rgba(255, 77, 79, 0.12)'; // Red
}

/**
 * Create a horizontal gradient background for context window progress
 *
 * @param used - Tokens used
 * @param limit - Token limit
 * @returns CSS gradient string or undefined if no data
 */
export function getContextWindowGradient(
  used: number | undefined,
  limit: number | undefined
): string | undefined {
  if (!used || !limit) return undefined;

  const percentage = (used / limit) * 100;
  const color = getContextWindowColor(percentage);

  return `linear-gradient(to right, ${color} ${percentage}%, transparent ${percentage}%)`;
}

/**
 * Calculate context window usage percentage
 *
 * @param used - Tokens used
 * @param limit - Token limit
 * @returns Percentage (0-100) or 0 if no data
 */
export function getContextWindowPercentage(
  used: number | undefined,
  limit: number | undefined
): number {
  if (!used || !limit) return 0;
  return (used / limit) * 100;
}
