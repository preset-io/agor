/**
 * Config Service
 *
 * Provides REST + WebSocket API for configuration management.
 * Wraps @agor/core/config functions for UI access.
 */

import { type AgorConfig, loadConfig, saveConfig } from '@agor/core/config';
import type { Params } from '@agor/core/types';

/**
 * Mask API keys for secure display
 */
function maskApiKey(key: string | undefined): string | undefined {
  if (!key || typeof key !== 'string') return undefined;
  if (key.length <= 10) return '***';
  return `${key.substring(0, 10)}...`;
}

/**
 * Mask all credentials in config
 */
function maskCredentials(config: AgorConfig): AgorConfig {
  if (!config.credentials) return config;

  return {
    ...config,
    credentials: {
      ANTHROPIC_API_KEY: maskApiKey(config.credentials.ANTHROPIC_API_KEY),
      OPENAI_API_KEY: maskApiKey(config.credentials.OPENAI_API_KEY),
      GEMINI_API_KEY: maskApiKey(config.credentials.GEMINI_API_KEY),
    },
  };
}

/**
 * Config service class
 */
export class ConfigService {
  /**
   * Get full config (masked)
   */
  async find(_params?: Params): Promise<AgorConfig> {
    const config = await loadConfig();
    return maskCredentials(config);
  }

  /**
   * Get specific config section or value
   */
  async get(id: string, _params?: Params): Promise<unknown> {
    const config = await loadConfig();
    const masked = maskCredentials(config);

    // Support dot notation (e.g., "credentials.ANTHROPIC_API_KEY")
    const parts = id.split('.');
    let value: unknown = masked;

    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = (value as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }

    return value;
  }

  /**
   * Update config values
   *
   * SECURITY: Only allow updating credentials section from UI
   */
  async patch(_id: null, data: Partial<AgorConfig>, _params?: Params): Promise<AgorConfig> {
    const config = await loadConfig();

    // Only allow updating credentials section for security
    if (data.credentials) {
      // Initialize credentials if not present
      if (!config.credentials) {
        config.credentials = {};
      }

      // Update or delete credential keys
      for (const [key, value] of Object.entries(data.credentials)) {
        if (value === undefined || value === null) {
          // Explicitly delete the key when value is undefined or null
          delete config.credentials[key as keyof typeof config.credentials];
        } else {
          // Set the key
          (config.credentials as Record<string, string>)[key] = value;
        }
      }
    }

    await saveConfig(config);

    // Propagate credentials to process.env for hot-reload
    // Precedence rule: config.yaml (UI) > environment variables
    if (data.credentials) {
      for (const [key, value] of Object.entries(data.credentials)) {
        if (value === undefined || value === null) {
          // Delete from process.env if credential was cleared
          delete process.env[key];
        } else {
          // Update process.env (UI takes precedence)
          process.env[key] = value;
        }
      }
    }

    // Return masked config
    return maskCredentials(config);
  }
}

/**
 * Service factory function
 */
export function createConfigService(): ConfigService {
  return new ConfigService();
}
