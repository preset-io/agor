import { describe, expect, it } from 'vitest';
import { BLOCKED_ENV_VARS, getEnvVarBlockReason, isEnvVarAllowed } from './env-blocklist';

describe('env-blocklist', () => {
  describe('BLOCKED_ENV_VARS set', () => {
    it('should contain PATH', () => {
      expect(BLOCKED_ENV_VARS.has('PATH')).toBe(true);
    });

    it('should contain SHELL', () => {
      expect(BLOCKED_ENV_VARS.has('SHELL')).toBe(true);
    });

    it('should contain HOME', () => {
      expect(BLOCKED_ENV_VARS.has('HOME')).toBe(true);
    });

    it('should contain USER', () => {
      expect(BLOCKED_ENV_VARS.has('USER')).toBe(true);
    });

    it('should contain LOGNAME', () => {
      expect(BLOCKED_ENV_VARS.has('LOGNAME')).toBe(true);
    });

    it('should contain LD_PRELOAD', () => {
      expect(BLOCKED_ENV_VARS.has('LD_PRELOAD')).toBe(true);
    });

    it('should contain LD_LIBRARY_PATH', () => {
      expect(BLOCKED_ENV_VARS.has('LD_LIBRARY_PATH')).toBe(true);
    });

    it('should contain DYLD_INSERT_LIBRARIES', () => {
      expect(BLOCKED_ENV_VARS.has('DYLD_INSERT_LIBRARIES')).toBe(true);
    });

    it('should contain DYLD_LIBRARY_PATH', () => {
      expect(BLOCKED_ENV_VARS.has('DYLD_LIBRARY_PATH')).toBe(true);
    });

    it('should contain AGOR_MASTER_SECRET', () => {
      expect(BLOCKED_ENV_VARS.has('AGOR_MASTER_SECRET')).toBe(true);
    });

    it('should have a reasonable number of blocked variables', () => {
      // Should have at least the known security-critical variables
      expect(BLOCKED_ENV_VARS.size).toBeGreaterThanOrEqual(9);
    });
  });

  describe('isEnvVarAllowed', () => {
    describe('blocked variables', () => {
      it('should reject PATH', () => {
        expect(isEnvVarAllowed('PATH')).toBe(false);
      });

      it('should reject SHELL', () => {
        expect(isEnvVarAllowed('SHELL')).toBe(false);
      });

      it('should reject HOME', () => {
        expect(isEnvVarAllowed('HOME')).toBe(false);
      });

      it('should reject USER', () => {
        expect(isEnvVarAllowed('USER')).toBe(false);
      });

      it('should reject LOGNAME', () => {
        expect(isEnvVarAllowed('LOGNAME')).toBe(false);
      });

      it('should reject LD_PRELOAD', () => {
        expect(isEnvVarAllowed('LD_PRELOAD')).toBe(false);
      });

      it('should reject LD_LIBRARY_PATH', () => {
        expect(isEnvVarAllowed('LD_LIBRARY_PATH')).toBe(false);
      });

      it('should reject DYLD_INSERT_LIBRARIES', () => {
        expect(isEnvVarAllowed('DYLD_INSERT_LIBRARIES')).toBe(false);
      });

      it('should reject DYLD_LIBRARY_PATH', () => {
        expect(isEnvVarAllowed('DYLD_LIBRARY_PATH')).toBe(false);
      });

      it('should reject AGOR_MASTER_SECRET', () => {
        expect(isEnvVarAllowed('AGOR_MASTER_SECRET')).toBe(false);
      });
    });

    describe('allowed variables', () => {
      it('should allow GITHUB_TOKEN', () => {
        expect(isEnvVarAllowed('GITHUB_TOKEN')).toBe(true);
      });

      it('should allow NPM_TOKEN', () => {
        expect(isEnvVarAllowed('NPM_TOKEN')).toBe(true);
      });

      it('should allow AWS_ACCESS_KEY_ID', () => {
        expect(isEnvVarAllowed('AWS_ACCESS_KEY_ID')).toBe(true);
      });

      it('should allow AWS_SECRET_ACCESS_KEY', () => {
        expect(isEnvVarAllowed('AWS_SECRET_ACCESS_KEY')).toBe(true);
      });

      it('should allow custom application variables', () => {
        expect(isEnvVarAllowed('MY_CUSTOM_VAR')).toBe(true);
      });

      it('should allow database connection strings', () => {
        expect(isEnvVarAllowed('DATABASE_URL')).toBe(true);
      });

      it('should allow API keys with various patterns', () => {
        expect(isEnvVarAllowed('STRIPE_API_KEY')).toBe(true);
        expect(isEnvVarAllowed('TWILIO_API_KEY')).toBe(true);
        expect(isEnvVarAllowed('OPENAI_API_KEY')).toBe(true);
      });
    });

    describe('case sensitivity', () => {
      it('should handle lowercase blocklist variables as invalid format (uppercase enforcement)', () => {
        // Note: These will be handled by validation layer, isEnvVarAllowed checks uppercase only
        expect(isEnvVarAllowed('path')).toBe(false);
        expect(isEnvVarAllowed('shell')).toBe(false);
      });

      it('should convert to uppercase for comparison', () => {
        expect(isEnvVarAllowed('path')).toBe(false);
        expect(isEnvVarAllowed('PATH')).toBe(false);
      });
    });

    describe('library injection vectors', () => {
      it('should block LD_PRELOAD (Unix/Linux injection)', () => {
        expect(isEnvVarAllowed('LD_PRELOAD')).toBe(false);
      });

      it('should block LD_LIBRARY_PATH (Unix/Linux library hijacking)', () => {
        expect(isEnvVarAllowed('LD_LIBRARY_PATH')).toBe(false);
      });

      it('should block DYLD_INSERT_LIBRARIES (macOS injection)', () => {
        expect(isEnvVarAllowed('DYLD_INSERT_LIBRARIES')).toBe(false);
      });

      it('should block DYLD_LIBRARY_PATH (macOS library hijacking)', () => {
        expect(isEnvVarAllowed('DYLD_LIBRARY_PATH')).toBe(false);
      });
    });

    describe('system environment protection', () => {
      it('should block PATH (command execution hijacking)', () => {
        expect(isEnvVarAllowed('PATH')).toBe(false);
      });

      it('should block SHELL (shell breakage)', () => {
        expect(isEnvVarAllowed('SHELL')).toBe(false);
      });

      it('should block HOME (filesystem breakage)', () => {
        expect(isEnvVarAllowed('HOME')).toBe(false);
      });

      it('should block USER (system context)', () => {
        expect(isEnvVarAllowed('USER')).toBe(false);
      });

      it('should block LOGNAME (alternate user identifier)', () => {
        expect(isEnvVarAllowed('LOGNAME')).toBe(false);
      });
    });
  });

  describe('getEnvVarBlockReason', () => {
    it('should return null for allowed variables', () => {
      expect(getEnvVarBlockReason('GITHUB_TOKEN')).toBeNull();
    });

    it('should return reason for PATH', () => {
      const reason = getEnvVarBlockReason('PATH');
      expect(reason).not.toBeNull();
      expect(reason).toContain('PATH');
      expect(reason?.toLowerCase()).toContain('dangerous');
    });

    it('should return reason for SHELL', () => {
      const reason = getEnvVarBlockReason('SHELL');
      expect(reason).not.toBeNull();
      expect(reason?.toLowerCase()).toContain('shell');
    });

    it('should return reason for HOME', () => {
      const reason = getEnvVarBlockReason('HOME');
      expect(reason).not.toBeNull();
      expect(reason?.toLowerCase()).toContain('home');
    });

    it('should return reason for USER', () => {
      const reason = getEnvVarBlockReason('USER');
      expect(reason).not.toBeNull();
      expect(reason?.toUpperCase()).toContain('USER');
    });

    it('should return reason for LD_PRELOAD', () => {
      const reason = getEnvVarBlockReason('LD_PRELOAD');
      expect(reason).not.toBeNull();
      expect(reason?.toLowerCase()).toContain('injection');
    });

    it('should return reason for DYLD_INSERT_LIBRARIES', () => {
      const reason = getEnvVarBlockReason('DYLD_INSERT_LIBRARIES');
      expect(reason).not.toBeNull();
      expect(reason?.toLowerCase()).toContain('injection');
    });

    it('should return reason for AGOR_MASTER_SECRET', () => {
      const reason = getEnvVarBlockReason('AGOR_MASTER_SECRET');
      expect(reason).not.toBeNull();
      expect(reason).toContain('encryption');
    });

    it('should provide human-readable reasons', () => {
      const reason = getEnvVarBlockReason('PATH');
      expect(reason).toBeDefined();
      expect(typeof reason).toBe('string');
      expect(reason!.length).toBeGreaterThan(0);
    });

    it('should distinguish between different block reasons', () => {
      const pathReason = getEnvVarBlockReason('PATH');
      const ldReason = getEnvVarBlockReason('LD_PRELOAD');
      expect(pathReason).not.toBe(ldReason);
    });
  });

  describe('security-critical variables', () => {
    it('should block all library injection vectors', () => {
      const injectionVectors = [
        'LD_PRELOAD',
        'LD_LIBRARY_PATH',
        'DYLD_INSERT_LIBRARIES',
        'DYLD_LIBRARY_PATH',
      ];
      injectionVectors.forEach((vec) => {
        expect(isEnvVarAllowed(vec)).toBe(false);
        const reason = getEnvVarBlockReason(vec);
        const hasInjectionOrHijack =
          reason?.toLowerCase().includes('injection') || reason?.toLowerCase().includes('hijack');
        expect(hasInjectionOrHijack).toBe(true);
      });
    });

    it('should block all system identity variables', () => {
      const systemVars = ['PATH', 'SHELL', 'HOME', 'USER', 'LOGNAME'];
      systemVars.forEach((varName) => {
        expect(isEnvVarAllowed(varName)).toBe(false);
      });
    });

    it('should protect Agor security infrastructure', () => {
      expect(isEnvVarAllowed('AGOR_MASTER_SECRET')).toBe(false);
      const reason = getEnvVarBlockReason('AGOR_MASTER_SECRET');
      expect(reason).toContain('encryption');
    });
  });

  describe('edge cases', () => {
    it('should handle empty string', () => {
      expect(isEnvVarAllowed('')).toBe(true);
      expect(getEnvVarBlockReason('')).toBeNull();
    });

    it('should handle very long variable names', () => {
      const longName = 'A'.repeat(500);
      expect(isEnvVarAllowed(longName)).toBe(true);
      expect(getEnvVarBlockReason(longName)).toBeNull();
    });

    it('should handle special characters in variable names', () => {
      // These wouldn't pass validation, but blocklist check should handle them
      expect(isEnvVarAllowed('VAR-NAME')).toBe(true);
      expect(isEnvVarAllowed('VAR.NAME')).toBe(true);
      expect(isEnvVarAllowed('VAR:NAME')).toBe(true);
    });

    it('should be case-insensitive for blocked variables', () => {
      expect(isEnvVarAllowed('path')).toBe(false);
      expect(isEnvVarAllowed('PATH')).toBe(false);
      expect(isEnvVarAllowed('Path')).toBe(false);
      expect(isEnvVarAllowed('pAtH')).toBe(false);
    });
  });
});
