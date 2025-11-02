/**
 * Blocklist of dangerous environment variables that users cannot set
 *
 * These variables could be used for:
 * - Library injection attacks (LD_PRELOAD, DYLD_INSERT_LIBRARIES)
 * - System command hijacking (PATH)
 * - Shell environment breakage (SHELL, HOME, USER)
 * - Security infrastructure bypass (LD_LIBRARY_PATH)
 * - Agor security override (AGOR_MASTER_SECRET)
 */
export const BLOCKED_ENV_VARS = new Set([
  // Library injection vectors (Unix/Linux)
  'LD_PRELOAD', // Preload libraries before program starts
  'LD_LIBRARY_PATH', // Override library search path

  // Library injection vectors (macOS)
  'DYLD_INSERT_LIBRARIES', // Insert libraries into macOS processes
  'DYLD_LIBRARY_PATH', // Override library search path on macOS

  // System environment (too dangerous to override)
  'PATH', // Command search path - hijacking this breaks everything
  'SHELL', // Shell selection - could break terminal
  'HOME', // Home directory - could break filesystem operations
  'USER', // User context - could confuse subsystems
  'LOGNAME', // Alternate user identifier

  // Agor security
  'AGOR_MASTER_SECRET', // Never allow users to override encryption key
]);

/**
 * Validate environment variable name against blocklist
 *
 * @param varName - Variable name to validate
 * @returns true if valid, false if blocked
 */
export function isEnvVarAllowed(varName: string): boolean {
  return !BLOCKED_ENV_VARS.has(varName.toUpperCase());
}

/**
 * Get human-readable reason why a variable is blocked
 */
export function getEnvVarBlockReason(varName: string): string | null {
  const upper = varName.toUpperCase();

  if (!BLOCKED_ENV_VARS.has(upper)) {
    return null;
  }

  const reasons: Record<string, string> = {
    LD_PRELOAD: 'LD_PRELOAD can be used for library injection attacks',
    LD_LIBRARY_PATH: 'LD_LIBRARY_PATH can hijack system library loading',
    DYLD_INSERT_LIBRARIES: 'DYLD_INSERT_LIBRARIES can be used for library injection attacks',
    DYLD_LIBRARY_PATH: 'DYLD_LIBRARY_PATH can hijack macOS library loading',
    PATH: 'PATH is too dangerous to override - it would break command execution',
    SHELL: 'SHELL selection could break terminal environments',
    HOME: 'HOME directory override could break filesystem operations',
    USER: 'USER context is system-critical and cannot be overridden',
    LOGNAME: 'LOGNAME is a system identifier and cannot be overridden',
    AGOR_MASTER_SECRET: 'AGOR_MASTER_SECRET is reserved for Agor encryption infrastructure',
  };

  return reasons[upper] || `${upper} is blocked for security reasons`;
}
