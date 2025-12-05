/**
 * API Credentials Initialization
 *
 * Handles initialization of API keys for Claude, Gemini, and other AI services.
 * Priority: config.yaml > environment variable
 * Supports hot-reload via config service updates.
 */

export interface CredentialsConfig {
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
}

export interface InitializedCredentials {
  anthropicApiKey?: string;
  geminiApiKey?: string;
}

/**
 * Initialize Anthropic API key for Claude Code
 *
 * Priority: config.yaml > env var
 * If no API key is found, Claude CLI authentication will be used as fallback.
 *
 * @param config - Application config object with credentials
 * @param envApiKey - ANTHROPIC_API_KEY from process.env
 * @returns Resolved API key or undefined (triggers CLI auth fallback)
 */
export function initializeAnthropicApiKey(
  config: { credentials?: CredentialsConfig },
  envApiKey?: string
): string | undefined {
  // Handle ANTHROPIC_API_KEY with priority: config.yaml > env var
  // Config service will update process.env when credentials change (hot-reload)
  // Tools will read fresh credentials dynamically via getCredential() helper
  if (config.credentials?.ANTHROPIC_API_KEY && !envApiKey) {
    process.env.ANTHROPIC_API_KEY = config.credentials.ANTHROPIC_API_KEY;
    console.log('✅ Set ANTHROPIC_API_KEY from config for Claude Code');
  }

  const apiKey = config.credentials?.ANTHROPIC_API_KEY || envApiKey;

  // Note: API key is optional - it can be configured per-tool or use Claude CLI's auth
  // Only show info message if no key is found (not a warning since it's not required)
  if (!apiKey) {
    console.log('ℹ️  No ANTHROPIC_API_KEY found - will use Claude CLI auth if available');
    console.log('   To use API key: agor config set credentials.ANTHROPIC_API_KEY <key>');
    console.log('   Or run: claude login');
  }

  return apiKey;
}

/**
 * Initialize Gemini API key with OAuth fallback support
 *
 * Priority: config.yaml > env var
 * If no API key is found, GeminiTool will fall back to OAuth via Gemini CLI
 *
 * @param config - Application config object with credentials
 * @param envApiKey - GEMINI_API_KEY from process.env
 * @returns Resolved API key or undefined (triggers OAuth fallback)
 */
export function initializeGeminiApiKey(
  config: { credentials?: CredentialsConfig },
  envApiKey?: string
): string | undefined {
  // Handle GEMINI_API_KEY with priority: config.yaml > env var
  // Config service will update process.env when credentials change (hot-reload)
  // GeminiTool will read fresh credentials dynamically via refreshAuth()
  // If no API key is found, GeminiTool will fall back to OAuth via Gemini CLI
  if (config.credentials?.GEMINI_API_KEY && !envApiKey) {
    process.env.GEMINI_API_KEY = config.credentials.GEMINI_API_KEY;
    console.log('✅ Set GEMINI_API_KEY from config for Gemini');
  }

  const geminiApiKey = config.credentials?.GEMINI_API_KEY || envApiKey;

  if (!geminiApiKey) {
    console.warn('⚠️  No GEMINI_API_KEY found - will use OAuth authentication');
    console.warn('   To use API key: agor config set credentials.GEMINI_API_KEY <your-key>');
    console.warn('   Or set GEMINI_API_KEY environment variable');
    console.warn('   OAuth requires: gemini CLI installed and authenticated');
  }

  return geminiApiKey;
}

/**
 * Initialize all AI service credentials
 *
 * Convenience function to initialize all supported API keys at once.
 *
 * @param config - Application config object with credentials
 * @returns Object containing all resolved API keys
 */
export function initializeCredentials(config: {
  credentials?: CredentialsConfig;
}): InitializedCredentials {
  return {
    anthropicApiKey: initializeAnthropicApiKey(config, process.env.ANTHROPIC_API_KEY),
    geminiApiKey: initializeGeminiApiKey(config, process.env.GEMINI_API_KEY),
  };
}
