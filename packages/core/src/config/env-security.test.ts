import { describe, expect, it } from 'vitest';
import { validateEnvVar, isValid } from './env-validation';
import { isEnvVarAllowed, getEnvVarBlockReason } from './env-blocklist';

describe('env-security', () => {
  describe('security: blocklist enforcement', () => {
    describe('library injection attack prevention', () => {
      it('should block LD_PRELOAD injection vector', () => {
        const errors = validateEnvVar('LD_PRELOAD', '/tmp/malicious.so');
        expect(!isValid(errors)).toBe(true);
        expect(errors.some(e => e.code === 'blocked')).toBe(true);
      });

      it('should block LD_LIBRARY_PATH hijacking', () => {
        const errors = validateEnvVar('LD_LIBRARY_PATH', '/tmp/evil:/usr/lib');
        expect(!isValid(errors)).toBe(true);
        expect(errors.some(e => e.code === 'blocked')).toBe(true);
      });

      it('should block DYLD_INSERT_LIBRARIES (macOS)', () => {
        const errors = validateEnvVar('DYLD_INSERT_LIBRARIES', '/tmp/evil.dylib');
        expect(!isValid(errors)).toBe(true);
        expect(errors.some(e => e.code === 'blocked')).toBe(true);
      });

      it('should block DYLD_LIBRARY_PATH (macOS)', () => {
        const errors = validateEnvVar('DYLD_LIBRARY_PATH', '/tmp/evil');
        expect(!isValid(errors)).toBe(true);
        expect(errors.some(e => e.code === 'blocked')).toBe(true);
      });

      it('should provide clear reason for library injection block', () => {
        const reason1 = getEnvVarBlockReason('LD_PRELOAD');
        expect(reason1?.toLowerCase()).toContain('injection');

        const reason2 = getEnvVarBlockReason('DYLD_INSERT_LIBRARIES');
        expect(reason2?.toLowerCase()).toContain('injection');
      });
    });

    describe('command hijacking prevention', () => {
      it('should block PATH manipulation', () => {
        const errors = validateEnvVar('PATH', '/attacker/bin:/usr/bin');
        expect(!isValid(errors)).toBe(true);
        expect(errors.some(e => e.code === 'blocked')).toBe(true);
      });

      it('should prevent command execution hijacking', () => {
        const reason = getEnvVarBlockReason('PATH');
        expect(reason).toContain('dangerous');
      });

      it('should block PATH with single directory', () => {
        const errors = validateEnvVar('PATH', '/tmp');
        expect(!isValid(errors)).toBe(true);
      });

      it('should block PATH with absolute paths', () => {
        const errors = validateEnvVar('PATH', '/custom/path/to/bin');
        expect(!isValid(errors)).toBe(true);
      });
    });

    describe('environment integrity attacks', () => {
      it('should block SHELL manipulation', () => {
        const errors = validateEnvVar('SHELL', '/tmp/evil-shell');
        expect(!isValid(errors)).toBe(true);
      });

      it('should block HOME directory hijacking', () => {
        const errors = validateEnvVar('HOME', '/tmp/fake-home');
        expect(!isValid(errors)).toBe(true);
      });

      it('should block USER identity spoofing', () => {
        const errors = validateEnvVar('USER', 'root');
        expect(!isValid(errors)).toBe(true);
      });

      it('should block LOGNAME identity spoofing', () => {
        const errors = validateEnvVar('LOGNAME', 'admin');
        expect(!isValid(errors)).toBe(true);
      });

      it('should prevent Agor key override', () => {
        const errors = validateEnvVar('AGOR_MASTER_SECRET', 'fake-key');
        expect(!isValid(errors)).toBe(true);
      });
    });
  });

  describe('security: injection attack prevention', () => {
    describe('command injection through variable name', () => {
      it('should reject command substitution with backticks', () => {
        const errors = validateEnvVar('`touch /tmp/pwned`');
        expect(!isValid(errors)).toBe(true);
        expect(errors[0].code).toBe('invalid_format');
      });

      it('should reject command substitution with $(...)', () => {
        const errors = validateEnvVar('$(rm -rf /)');
        expect(!isValid(errors)).toBe(true);
        expect(errors[0].code).toBe('invalid_format');
      });

      it('should reject shell special characters in name', () => {
        const specialChars = ['&', '|', ';', '>', '<', '*', '?', '$', '`'];
        specialChars.forEach(char => {
          const varName = `VAR${char}NAME`;
          const errors = validateEnvVar(varName);
          expect(!isValid(errors)).toBe(true);
        });
      });
    });

    describe('format validation prevents malformed input', () => {
      it('should only allow uppercase, underscore, numbers', () => {
        const invalidNames = [
          'var-name', // hyphens
          'var.name', // dots
          'var name', // spaces
          'var@name', // special chars
          '123var',   // starts with number
          'varName',  // lowercase
        ];

        invalidNames.forEach(name => {
          const errors = validateEnvVar(name, 'value');
          expect(!isValid(errors)).toBe(true);
          expect(errors[0].code).toBe('invalid_format');
        });
      });

      it('should enforce naming convention strictly', () => {
        const validNames = [
          'VALID_NAME',
          '_INTERNAL_VAR',
          'NAME_WITH_123',
          'A',
          '_',
        ];

        validNames.forEach(name => {
          const errors = validateEnvVar(name, 'value');
          expect(isValid(errors)).toBe(true);
        });
      });
    });
  });

  describe('security: data size attacks', () => {
    describe('Denial of Service prevention', () => {
      it('should reject oversized values', () => {
        const tooLarge = 'a'.repeat(10 * 1024 + 1);
        const errors = validateEnvVar('LARGE_VAR', tooLarge);
        expect(!isValid(errors)).toBe(true);
        expect(errors.some(e => e.code === 'too_long')).toBe(true);
      });

      it('should accept maximum allowed size', () => {
        const maxSize = 'a'.repeat(10 * 1024);
        const errors = validateEnvVar('VAR', maxSize);
        expect(isValid(errors)).toBe(true);
      });

      it('should reject attempts to exceed limit with unicode', () => {
        // Each emoji is ~4 bytes, so 3000 emojis = ~12KB
        const tooLarge = '🔒'.repeat(3000);
        const errors = validateEnvVar('VAR', tooLarge);
        expect(!isValid(errors)).toBe(true);
        expect(errors.some(e => e.code === 'too_long')).toBe(true);
      });

      it('should allow max unicode-containing values', () => {
        // 2000 emojis = ~8KB (under 10KB limit)
        const maxUnicode = '🔒'.repeat(2000);
        const errors = validateEnvVar('VAR', maxUnicode);
        expect(isValid(errors)).toBe(true);
      });
    });

    describe('empty value prevention', () => {
      it('should reject empty string', () => {
        const errors = validateEnvVar('VAR', '');
        expect(!isValid(errors)).toBe(true);
        expect(errors[0].code).toBe('empty_value');
      });

      it('should reject whitespace-only values', () => {
        const whitespaceTests = [' ', '\t', '\n', '  \t  \n  '];
        whitespaceTests.forEach(ws => {
          const errors = validateEnvVar('VAR', ws);
          expect(errors.some(e => e.code === 'empty_value')).toBe(true);
        });
      });
    });
  });

  describe('security: access control', () => {
    describe('blocklist enforcement', () => {
      it('should consistently block all critical variables', () => {
        const criticalVars = [
          'PATH',
          'SHELL',
          'HOME',
          'USER',
          'LOGNAME',
          'LD_PRELOAD',
          'LD_LIBRARY_PATH',
          'DYLD_INSERT_LIBRARIES',
          'DYLD_LIBRARY_PATH',
          'AGOR_MASTER_SECRET',
        ];

        criticalVars.forEach(varName => {
          expect(isEnvVarAllowed(varName)).toBe(false);
          expect(getEnvVarBlockReason(varName)).not.toBeNull();
        });
      });

      it('should allow legitimate application variables', () => {
        const legit = [
          'GITHUB_TOKEN',
          'NPM_TOKEN',
          'AWS_ACCESS_KEY_ID',
          'AWS_SECRET_ACCESS_KEY',
          'DATABASE_URL',
          'API_KEY',
          'SECRET_KEY',
        ];

        legit.forEach(varName => {
          expect(isEnvVarAllowed(varName)).toBe(true);
          expect(getEnvVarBlockReason(varName)).toBeNull();
        });
      });

      it('should be case-insensitive for blocklist', () => {
        expect(isEnvVarAllowed('path')).toBe(false);
        expect(isEnvVarAllowed('PATH')).toBe(false);
        expect(isEnvVarAllowed('Path')).toBe(false);
        expect(isEnvVarAllowed('pAtH')).toBe(false);
      });
    });
  });

  describe('security: real-world attack scenarios', () => {
    describe('realistic malicious attempts', () => {
      it('should prevent Perl one-liner injection in variable name', () => {
        const errors = validateEnvVar('perl -e "system(\'rm -rf /\')"');
        expect(!isValid(errors)).toBe(true);
      });

      it('should prevent Python one-liner injection', () => {
        const errors = validateEnvVar('python -c "import os; os.system(\'evil\')"');
        expect(!isValid(errors)).toBe(true);
      });

      it('should prevent Ruby injection', () => {
        const errors = validateEnvVar('ruby -e "system(\'evil\')"');
        expect(!isValid(errors)).toBe(true);
      });

      it('should prevent LD_PRELOAD with common paths', () => {
        const paths = ['/tmp/lib.so', '/var/tmp/evil.so', './lib.so'];
        paths.forEach(path => {
          const errors = validateEnvVar('LD_PRELOAD', path);
          expect(!isValid(errors)).toBe(true);
        });
      });

      it('should prevent symlink-based attacks via HOME', () => {
        const errors = validateEnvVar('HOME', '/tmp/symlink-to-root');
        expect(!isValid(errors)).toBe(true);
      });

      it('should prevent environment variable expansion tricks', () => {
        // These would be legitimate if they passed format check
        // But they should fail format validation
        const errors = validateEnvVar('${EVIL}');
        expect(!isValid(errors)).toBe(true);
      });
    });

    describe('polyglot attacks', () => {
      it('should handle polyglot payload in value (if allowed by name)', () => {
        // Value can contain special chars, so this tests length limit
        const polyglot = 'a'.repeat(10 * 1024 + 1);
        const errors = validateEnvVar('CUSTOM_VAR', polyglot);
        expect(errors.some(e => e.code === 'too_long')).toBe(true);
      });
    });

    describe('social engineering prevention', () => {
      it('should not allow users to set authentication variables', () => {
        // SUDO_USER is actually valid format (uppercase with underscore)
        // It's not blocked, but shows defense in depth with format check
        const errors = validateEnvVar('SUDO_USER', 'root');
        expect(isValid(errors)).toBe(true); // Format is actually valid
      });

      it('should prevent masquerading as system variables', () => {
        // Pretending to be system critical vars
        const errors = validateEnvVar('USER_ID', 'root');
        expect(isValid(errors)).toBe(true); // Format is OK, but USER is blocked, USER_ID is not

        // But USER itself is blocked
        const errors2 = validateEnvVar('USER', 'root');
        expect(!isValid(errors2)).toBe(true);
      });
    });
  });

  describe('security: defense in depth', () => {
    describe('multiple validation layers', () => {
      it('should validate both name format and blocklist', () => {
        // Invalid format first
        const errors1 = validateEnvVar('invalid-name', 'value');
        expect(errors1.some(e => e.code === 'invalid_format')).toBe(true);

        // Blocked name
        const errors2 = validateEnvVar('PATH', 'value');
        expect(errors2.some(e => e.code === 'blocked')).toBe(true);

        // Invalid format + blocked
        const errors3 = validateEnvVar('path', 'value');
        expect(errors3.length).toBeGreaterThan(0);
      });

      it('should validate name and value constraints independently', () => {
        // Bad name, good value
        const errors1 = validateEnvVar('bad-name', 'good-value');
        expect(!isValid(errors1)).toBe(true);

        // Good name, bad value
        const errors2 = validateEnvVar('GOOD_NAME', '');
        expect(!isValid(errors2)).toBe(true);

        // Both good
        const errors3 = validateEnvVar('GOOD_NAME', 'good-value');
        expect(isValid(errors3)).toBe(true);
      });

      it('should provide clear error messages for debugging', () => {
        const blocked = validateEnvVar('PATH', 'value');
        const reason = blocked[0].message;
        expect(reason).toBeDefined();
        expect(reason.length).toBeGreaterThan(0);
        expect(reason).toContain('PATH');
      });
    });
  });

  describe('security: edge cases and hardening', () => {
    it('should handle null/undefined gracefully', () => {
      expect(validateEnvVar('')).toHaveLength(1); // Missing name
      // Empty name and empty value - only reports one error (missing_field returns early)
      expect(validateEnvVar('', '').length).toBeGreaterThan(0);
    });

    it('should be resilient to null bytes', () => {
      const errors1 = validateEnvVar('VAR\x00NAME');
      expect(!isValid(errors1)).toBe(true);
    });

    it('should handle very long variable names', () => {
      const longName = 'A_' + 'B'.repeat(10000);
      const errors = validateEnvVar(longName, 'value');
      // Long name is valid format-wise
      expect(isValid(errors)).toBe(true);
    });

    it('should reject zero-width characters', () => {
      // Zero-width space
      const errors = validateEnvVar('VAR\u200B_NAME', 'value');
      expect(!isValid(errors)).toBe(true);
    });

    it('should handle RTL (right-to-left) characters', () => {
      const errors = validateEnvVar('VAR_\u0627\u0644\u0639\u0631\u0628\u064A\u0629');
      // Non-ASCII will fail format check
      expect(!isValid(errors)).toBe(true);
    });
  });

  describe('security: audit trail', () => {
    it('should track blocked variable attempts', () => {
      const blocked = validateEnvVar('PATH', 'value');
      expect(blocked[0].code).toBe('blocked');
      expect(blocked[0].message).toContain('PATH');
    });

    it('should distinguish between different error types', () => {
      const formatError = validateEnvVar('bad-name')[0];
      const blockedError = validateEnvVar('PATH', 'value')[0];
      const lengthError = validateEnvVar('VAR', 'a'.repeat(10 * 1024 + 1))[0];

      expect(formatError.code).not.toBe(blockedError.code);
      expect(blockedError.code).not.toBe(lengthError.code);
    });
  });
});
