/**
 * Config Service
 *
 * Provides REST + WebSocket API for configuration management.
 * Wraps @agor/core/config functions for UI access.
 */

import { type AgorConfig, loadConfig, resolveApiKey, saveConfig } from '@agor/core/config';
import type { Database } from '@agor/core/db';
import type { Params, TaskID, UserID } from '@agor/core/types';

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
      ANTHROPIC_BASE_URL: config.credentials.ANTHROPIC_BASE_URL,
      OPENAI_API_KEY: maskApiKey(config.credentials.OPENAI_API_KEY),
      GEMINI_API_KEY: maskApiKey(config.credentials.GEMINI_API_KEY),
    },
  };
}

/**
 * Config service class
 */
export class ConfigService {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

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
   * Custom method: Resolve API key for a task
   *
   * This allows executors to request API key resolution without direct database access.
   * The service handles the precedence: user-level > config > env > native auth.
   *
   * Called via: client.service('config').resolveApiKey({ taskId, keyName })
   */
  async resolveApiKey(data: { taskId: TaskID; keyName: string }): Promise<{
    apiKey: string | null;
    source: 'user' | 'config' | 'env' | 'native';
    useNativeAuth: boolean;
    decryptionFailed?: boolean;
  }> {
    const { taskId, keyName } = data;

    // Fetch task to get creator user ID
    let userId: UserID | undefined;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: App reference stored dynamically for cross-service calls
      const tasksService = (this as any).app?.service('tasks');
      if (tasksService) {
        const task = await tasksService.get(taskId, { provider: undefined });
        userId = task?.created_by;
      }
    } catch (err) {
      console.warn(`[Config.resolveApiKey] Failed to fetch task ${taskId}:`, err);
    }

    // Use core resolveApiKey with database access
    // biome-ignore lint/suspicious/noExplicitAny: ApiKeyName type check happens at runtime
    const result = await resolveApiKey(keyName as any, {
      userId,
      db: this.db,
    });

    // Map KeyResolutionResult to service response type
    return {
      apiKey: result.apiKey ?? null,
      source: result.source === 'none' ? 'native' : result.source,
      useNativeAuth: result.useNativeAuth,
      ...(result.decryptionFailed && { decryptionFailed: true }),
    };
  }

  /**
   * Update config values
   *
   * SECURITY: Only allow updating credentials and opencode sections from UI
   */
  async patch(_id: null, data: Partial<AgorConfig>, _params?: Params): Promise<AgorConfig> {
    console.log('[Config Service] Patch received:', JSON.stringify(data, null, 2));
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

    // Allow updating opencode configuration
    if (data.opencode) {
      // Initialize opencode if not present
      if (!config.opencode) {
        config.opencode = {};
      }

      // Update opencode settings
      if (data.opencode.enabled !== undefined) {
        config.opencode.enabled = data.opencode.enabled;
      }
      if (data.opencode.serverUrl !== undefined) {
        config.opencode.serverUrl = data.opencode.serverUrl;
      }
    }

    // Allow updating onboarding configuration
    if (data.onboarding) {
      if (!config.onboarding) {
        config.onboarding = {};
      }
      if (data.onboarding.persistedAgentPending !== undefined) {
        config.onboarding.persistedAgentPending = data.onboarding.persistedAgentPending;
      }
      if (data.onboarding.frameworkRepoUrl !== undefined) {
        config.onboarding.frameworkRepoUrl = data.onboarding.frameworkRepoUrl;
      }
    }

    // Allow updating codex configuration
    if (data.codex) {
      if (!config.codex) {
        config.codex = {};
      }

      if (data.codex.home !== undefined) {
        const home = data.codex.home;
        if (home === null || home === '') {
          // Treat empty string as unset
          delete config.codex.home;
        } else if (typeof home === 'string') {
          config.codex.home = home;
        } else {
          throw new Error('codex.home must be a string');
        }
      }
    }

    await saveConfig(config);
    console.log('[Config Service] Config saved successfully');

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
export function createConfigService(db: Database): ConfigService {
  return new ConfigService(db);
}
