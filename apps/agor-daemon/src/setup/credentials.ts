/**
 * API Credentials Initialization
 *
 * Handles initialization of API keys for Claude, Gemini, and other AI services.
 * Priority: config.yaml > environment variable
 * Supports hot-reload via config service updates.
 */

import type { AgorCredentials } from '@agor/core/config';

/**
 * @deprecated Use AgorCredentials from @agor/core/config directly
 */
export type CredentialsConfig = AgorCredentials;

export interface InitializedCredentials {
  anthropicApiKey?: string;
  anthropicAuthToken?: string;
  anthropicBaseUrl?: string;
  geminiApiKey?: string;
  copilotGithubToken?: string;
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
 * Initialize Anthropic auth token for proxy/enterprise setups
 *
 * Priority: config.yaml > env var
 * Used by Claude Code SDK for token-based authentication (e.g., AWS Bedrock, OAuth proxies).
 *
 * @param config - Application config object with credentials
 * @param envAuthToken - ANTHROPIC_AUTH_TOKEN from process.env
 * @returns Resolved auth token or undefined
 */
export function initializeAnthropicAuthToken(
  config: { credentials?: CredentialsConfig },
  envAuthToken?: string
): string | undefined {
  if (config.credentials?.ANTHROPIC_AUTH_TOKEN && !envAuthToken) {
    process.env.ANTHROPIC_AUTH_TOKEN = config.credentials.ANTHROPIC_AUTH_TOKEN;
    console.log('✅ Set ANTHROPIC_AUTH_TOKEN from config for Claude Code');
  }

  return config.credentials?.ANTHROPIC_AUTH_TOKEN || envAuthToken;
}

/**
 * Initialize Anthropic base URL for proxy/custom endpoint support
 *
 * Priority: config.yaml > env var
 * Used for LiteLLM proxies, AWS Bedrock, Claude Enterprise, or compatible APIs.
 *
 * @param config - Application config object with credentials
 * @param envBaseUrl - ANTHROPIC_BASE_URL from process.env
 * @returns Resolved base URL or undefined (uses default https://api.anthropic.com)
 */
export function initializeAnthropicBaseUrl(
  config: { credentials?: CredentialsConfig },
  envBaseUrl?: string
): string | undefined {
  if (config.credentials?.ANTHROPIC_BASE_URL && !envBaseUrl) {
    process.env.ANTHROPIC_BASE_URL = config.credentials.ANTHROPIC_BASE_URL;
    console.log('✅ Set ANTHROPIC_BASE_URL from config for Claude Code');
  }

  return config.credentials?.ANTHROPIC_BASE_URL || envBaseUrl;
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
 * Initialize GitHub token for Copilot agent
 *
 * Priority: config.yaml > COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN
 * Used by the Copilot SDK for GitHub authentication.
 *
 * @param config - Application config object with credentials
 * @param envCopilotToken - COPILOT_GITHUB_TOKEN from process.env
 * @param envGhToken - GH_TOKEN from process.env
 * @param envGithubToken - GITHUB_TOKEN from process.env
 * @returns Resolved GitHub token or undefined
 */
export function initializeCopilotGithubToken(
  config: { credentials?: CredentialsConfig },
  envCopilotToken?: string,
  envGhToken?: string,
  envGithubToken?: string
): string | undefined {
  if (config.credentials?.COPILOT_GITHUB_TOKEN && !envCopilotToken) {
    process.env.COPILOT_GITHUB_TOKEN = config.credentials.COPILOT_GITHUB_TOKEN;
    console.log('✅ Set COPILOT_GITHUB_TOKEN from config for Copilot');
  }

  const token =
    config.credentials?.COPILOT_GITHUB_TOKEN || envCopilotToken || envGhToken || envGithubToken;

  if (!token) {
    console.log('ℹ️  No COPILOT_GITHUB_TOKEN found - Copilot agent will not be available');
    console.log('   To use Copilot: agor config set credentials.COPILOT_GITHUB_TOKEN <token>');
    console.log('   Or set COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN env var');
  }

  return token;
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
    anthropicAuthToken: initializeAnthropicAuthToken(config, process.env.ANTHROPIC_AUTH_TOKEN),
    anthropicBaseUrl: initializeAnthropicBaseUrl(config, process.env.ANTHROPIC_BASE_URL),
    geminiApiKey: initializeGeminiApiKey(config, process.env.GEMINI_API_KEY),
    copilotGithubToken: initializeCopilotGithubToken(
      config,
      process.env.COPILOT_GITHUB_TOKEN,
      process.env.GH_TOKEN,
      process.env.GITHUB_TOKEN
    ),
  };
}
