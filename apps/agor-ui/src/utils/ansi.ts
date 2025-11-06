/**
 * ANSI utilities for detecting and handling terminal color codes
 */

/**
 * Checks if text contains ANSI escape codes
 */
export function hasAnsiCodes(text: string): boolean {
  // ANSI escape code pattern: ESC [ ... m
  // Using String constructor to avoid regex literal control character warning
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes require control characters
  const ansiPattern = /\u001b\[[\d;]*m/;
  return ansiPattern.test(text);
}

/**
 * List of tools that typically output terminal content
 */
export const TERMINAL_OUTPUT_TOOLS = [
  'Bash',
  'bash',
  'sh',
  'npm',
  'pnpm',
  'yarn',
  'git',
  'docker',
  'pytest',
  'jest',
  'cargo',
  'go',
];

/**
 * Checks if tool output should be rendered with ANSI support
 *
 * @param toolName - Name of the tool that produced the output
 * @param output - The output text to check
 * @returns true if the output should be rendered with ANSI support
 */
export function shouldUseAnsiRendering(toolName: string, output: string): boolean {
  // Check if tool is known to produce terminal output
  const isTerminalTool = TERMINAL_OUTPUT_TOOLS.includes(toolName);

  // OR check if output contains ANSI codes
  const hasAnsi = hasAnsiCodes(output);

  return isTerminalTool || hasAnsi;
}
