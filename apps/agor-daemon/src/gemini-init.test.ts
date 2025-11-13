import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeGeminiApiKey } from './index';

/**
 * Tests for the actual daemon Gemini initialization logic
 *
 * These tests verify the initializeGeminiApiKey function that handles
 * API key resolution and OAuth fallback behavior in the daemon.
 */

describe('initializeGeminiApiKey', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };

    // Spy on console methods
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;

    // Restore console methods
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  describe('API key resolution', () => {
    it('should return config API key when available and env is not set', () => {
      const config = {
        credentials: {
          GEMINI_API_KEY: 'config-api-key',
        },
      };

      delete process.env.GEMINI_API_KEY;

      const result = initializeGeminiApiKey(config, undefined);

      expect(result).toBe('config-api-key');
      expect(process.env.GEMINI_API_KEY).toBe('config-api-key');
      expect(consoleLogSpy).toHaveBeenCalledWith('✅ Set GEMINI_API_KEY from config for Gemini');
    });

    it('should return env API key when config is not set', () => {
      const config = {
        credentials: {},
      };

      const result = initializeGeminiApiKey(config, 'env-api-key');

      expect(result).toBe('env-api-key');
      expect(process.env.GEMINI_API_KEY).not.toBe('env-api-key'); // Should not modify existing env
    });

    it('should prioritize config over env when both exist', () => {
      const config = {
        credentials: {
          GEMINI_API_KEY: 'config-api-key',
        },
      };

      const result = initializeGeminiApiKey(config, 'env-api-key');

      expect(result).toBe('config-api-key');
      // Should NOT overwrite existing env var
      expect(process.env.GEMINI_API_KEY).not.toBe('config-api-key');
    });

    it('should return undefined when no API key is available (triggers OAuth)', () => {
      const config = {
        credentials: {},
      };

      const result = initializeGeminiApiKey(config, undefined);

      expect(result).toBeUndefined();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '⚠️  No GEMINI_API_KEY found - will use OAuth authentication'
      );
    });
  });

  describe('OAuth fallback warnings', () => {
    it('should log OAuth warning messages when no API key', () => {
      const config = {
        credentials: {},
      };

      initializeGeminiApiKey(config, undefined);

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '⚠️  No GEMINI_API_KEY found - will use OAuth authentication'
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '   To use API key: agor config set credentials.GEMINI_API_KEY <your-key>'
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith('   Or set GEMINI_API_KEY environment variable');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '   OAuth requires: gemini CLI installed and authenticated'
      );
    });

    it('should not log warnings when API key is available', () => {
      const config = {
        credentials: {
          GEMINI_API_KEY: 'test-key',
        },
      };

      initializeGeminiApiKey(config, undefined);

      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });
  });

  describe('process.env modifications', () => {
    it('should set process.env.GEMINI_API_KEY from config when env is not set', () => {
      const config = {
        credentials: {
          GEMINI_API_KEY: 'config-key',
        },
      };

      delete process.env.GEMINI_API_KEY;

      initializeGeminiApiKey(config, undefined);

      expect(process.env.GEMINI_API_KEY).toBe('config-key');
    });

    it('should not modify process.env when it already has a value', () => {
      const config = {
        credentials: {
          GEMINI_API_KEY: 'config-key',
        },
      };

      process.env.GEMINI_API_KEY = 'existing-env-key';

      initializeGeminiApiKey(config, 'existing-env-key');

      expect(process.env.GEMINI_API_KEY).toBe('existing-env-key');
    });

    it('should not set process.env when config has no API key', () => {
      const config = {
        credentials: {},
      };

      delete process.env.GEMINI_API_KEY;

      initializeGeminiApiKey(config, undefined);

      expect(process.env.GEMINI_API_KEY).toBeUndefined();
    });
  });

  describe('Edge cases', () => {
    it('should handle empty string config API key', () => {
      const config = {
        credentials: {
          GEMINI_API_KEY: '',
        },
      };

      const result = initializeGeminiApiKey(config, undefined);

      // Empty string is falsy, falls back to undefined
      expect(result).toBeUndefined();
      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it('should handle empty string env API key', () => {
      const config = {
        credentials: {},
      };

      const result = initializeGeminiApiKey(config, '');

      expect(result).toBeUndefined();
      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it('should handle null config.credentials', () => {
      const config = {
        credentials: null as any,
      };

      const result = initializeGeminiApiKey(config, undefined);

      expect(result).toBeUndefined();
      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it('should handle undefined config.credentials', () => {
      const config = {} as any;

      const result = initializeGeminiApiKey(config, undefined);

      expect(result).toBeUndefined();
      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it('should handle whitespace-only API key from config', () => {
      const config = {
        credentials: {
          GEMINI_API_KEY: '   ',
        },
      };

      const result = initializeGeminiApiKey(config, undefined);

      // Whitespace string is truthy (validation happens in GeminiTool)
      expect(result).toBe('   ');
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it('should handle whitespace-only API key from env', () => {
      const config = {
        credentials: {},
      };

      const result = initializeGeminiApiKey(config, '   ');

      expect(result).toBe('   ');
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });
  });

  describe('Config hot-reload behavior', () => {
    it('should update process.env when config changes from empty to having key', () => {
      delete process.env.GEMINI_API_KEY;

      // First call: no key
      let result = initializeGeminiApiKey({ credentials: {} }, undefined);
      expect(result).toBeUndefined();

      // Simulate config hot-reload with new key
      const updatedConfig = {
        credentials: {
          GEMINI_API_KEY: 'new-key',
        },
      };

      result = initializeGeminiApiKey(updatedConfig, undefined);
      expect(result).toBe('new-key');
      expect(process.env.GEMINI_API_KEY).toBe('new-key');
    });

    it('should respect explicitly set env var even after config update', () => {
      process.env.GEMINI_API_KEY = 'user-set-key';

      const config = {
        credentials: {
          GEMINI_API_KEY: 'config-key',
        },
      };

      const result = initializeGeminiApiKey(config, 'user-set-key');

      // Config value returned (priority)
      expect(result).toBe('config-key');
      // But env var not overwritten
      expect(process.env.GEMINI_API_KEY).toBe('user-set-key');
    });
  });

  describe('Return value consistency', () => {
    it('should return same value as what would be passed to GeminiTool constructor', () => {
      const config1 = { credentials: { GEMINI_API_KEY: 'test1' } };
      const config2 = { credentials: {} };
      const config3 = { credentials: { GEMINI_API_KEY: 'test3' } };

      const result1 = initializeGeminiApiKey(config1, undefined);
      const result2 = initializeGeminiApiKey(config2, 'env-key');
      const result3 = initializeGeminiApiKey(config3, 'env-key-ignored');

      expect(result1).toBe('test1');
      expect(result2).toBe('env-key');
      expect(result3).toBe('test3');
    });

    it('should return undefined when OAuth should be used', () => {
      const configs = [
        { credentials: {} },
        { credentials: { GEMINI_API_KEY: '' } },
        { credentials: null as any },
        {} as any,
      ];

      for (const config of configs) {
        const result = initializeGeminiApiKey(config, undefined);
        expect(result).toBeUndefined();
      }
    });
  });
});
