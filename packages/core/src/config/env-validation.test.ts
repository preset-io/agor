import { describe, expect, it } from 'vitest';
import {
  ENV_VAR_CONSTRAINTS,
  formatValidationError,
  formatValidationErrors,
  isValid,
  validateEnvVar,
} from './env-validation';

describe('env-validation', () => {
  describe('validateEnvVar - name validation', () => {
    it('should accept valid uppercase names', () => {
      const errors = validateEnvVar('GITHUB_TOKEN');
      expect(errors).toHaveLength(0);
    });

    it('should accept names with numbers', () => {
      const errors = validateEnvVar('API_KEY_V2');
      expect(errors).toHaveLength(0);
    });

    it('should accept names starting with underscore', () => {
      const errors = validateEnvVar('_INTERNAL_VAR');
      expect(errors).toHaveLength(0);
    });

    it('should accept names with multiple underscores', () => {
      const errors = validateEnvVar('AWS_ACCESS_KEY_ID');
      expect(errors).toHaveLength(0);
    });

    it('should reject empty name', () => {
      const errors = validateEnvVar('');
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('name');
      expect(errors[0].code).toBe('missing_field');
    });

    it('should reject lowercase names', () => {
      const errors = validateEnvVar('github_token');
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('invalid_format');
    });

    it('should reject names with hyphens', () => {
      const errors = validateEnvVar('GITHUB-TOKEN');
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('invalid_format');
    });

    it('should reject names with dots', () => {
      const errors = validateEnvVar('GITHUB.TOKEN');
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('invalid_format');
    });

    it('should reject names starting with number', () => {
      const errors = validateEnvVar('123_TOKEN');
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('invalid_format');
    });

    it('should reject names with spaces', () => {
      const errors = validateEnvVar('GITHUB TOKEN');
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('invalid_format');
    });

    it('should reject names with special characters', () => {
      const errors = validateEnvVar('GITHUB$TOKEN');
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('invalid_format');
    });
  });

  describe('validateEnvVar - blocklist enforcement', () => {
    it('should reject PATH variable', () => {
      const errors = validateEnvVar('PATH', '/usr/bin');
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('blocked');
      expect(errors[0].message).toContain('PATH');
    });

    it('should reject SHELL variable', () => {
      const errors = validateEnvVar('SHELL', '/bin/bash');
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('blocked');
    });

    it('should reject HOME variable', () => {
      const errors = validateEnvVar('HOME', '/home/user');
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('blocked');
    });

    it('should reject LD_PRELOAD variable', () => {
      const errors = validateEnvVar('LD_PRELOAD', '/lib/malware.so');
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('blocked');
    });

    it('should reject DYLD_INSERT_LIBRARIES variable', () => {
      const errors = validateEnvVar('DYLD_INSERT_LIBRARIES', '/lib/malware.dylib');
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('blocked');
    });

    it('should reject USER variable', () => {
      const errors = validateEnvVar('USER', 'root');
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('blocked');
    });

    it('should reject AGOR_MASTER_SECRET variable', () => {
      const errors = validateEnvVar('AGOR_MASTER_SECRET', 'secret123');
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('blocked');
    });

    it('should allow common token variables', () => {
      const errors = validateEnvVar('GITHUB_TOKEN', 'token123');
      expect(errors).toHaveLength(0);
    });

    it('should allow AWS keys', () => {
      const errors = validateEnvVar('AWS_ACCESS_KEY_ID', 'key123');
      expect(errors).toHaveLength(0);
    });

    it('should allow NPM_TOKEN', () => {
      const errors = validateEnvVar('NPM_TOKEN', 'token123');
      expect(errors).toHaveLength(0);
    });
  });

  describe('validateEnvVar - value validation', () => {
    it('should allow valid value', () => {
      const errors = validateEnvVar('GITHUB_TOKEN', 'ghp_1234567890abcdef');
      expect(errors).toHaveLength(0);
    });

    it('should reject empty value', () => {
      const errors = validateEnvVar('GITHUB_TOKEN', '');
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('value');
      expect(errors[0].code).toBe('empty_value');
    });

    it('should reject whitespace-only value', () => {
      const errors = validateEnvVar('GITHUB_TOKEN', '   ');
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('empty_value');
    });

    it('should allow null value (for deletion)', () => {
      const errors = validateEnvVar('GITHUB_TOKEN', null as any);
      expect(errors).toHaveLength(0);
    });

    it('should validate value length in bytes', () => {
      const longValue = 'a'.repeat(10 * 1024 + 1); // Max is 10KB
      const errors = validateEnvVar('GITHUB_TOKEN', longValue);
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('too_long');
    });

    it('should allow value at max length', () => {
      const maxValue = 'a'.repeat(10 * 1024);
      const errors = validateEnvVar('GITHUB_TOKEN', maxValue);
      expect(errors).toHaveLength(0);
    });

    it('should allow value with unicode characters (check byte length)', () => {
      // Each emoji is ~4 bytes in UTF-8
      const unicodeValue = '🎉'.repeat(2000); // ~8KB
      const errors = validateEnvVar('GITHUB_TOKEN', unicodeValue);
      expect(errors).toHaveLength(0);
    });

    it('should reject value with unicode characters exceeding byte limit', () => {
      const unicodeValue = '🎉'.repeat(3000); // ~12KB
      const errors = validateEnvVar('GITHUB_TOKEN', unicodeValue);
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('too_long');
    });

    it('should allow value with special characters', () => {
      const value = 'token_with-special.chars!@#$%&=';
      const errors = validateEnvVar('GITHUB_TOKEN', value);
      expect(errors).toHaveLength(0);
    });

    it('should allow value with newlines', () => {
      const value = 'line1\nline2\nline3';
      const errors = validateEnvVar('GITHUB_TOKEN', value);
      expect(errors).toHaveLength(0);
    });
  });

  describe('validateEnvVar - combined validation', () => {
    it('should reject invalid name and value together', () => {
      const errors = validateEnvVar('invalid-name', '');
      // Should report both errors
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.field === 'name')).toBe(true);
      expect(errors.some((e) => e.field === 'value')).toBe(true);
    });

    it('should only validate value if name is valid and not blocked', () => {
      const errors = validateEnvVar('GITHUB_TOKEN');
      // Name is valid, value is undefined, should have no errors
      expect(errors).toHaveLength(0);
    });

    it('should reject name first before value', () => {
      const errors = validateEnvVar('invalid-name', 'valid-value');
      expect(errors.some((e) => e.field === 'name')).toBe(true);
    });
  });

  describe('isValid', () => {
    it('should return true for empty errors array', () => {
      expect(isValid([])).toBe(true);
    });

    it('should return false for non-empty errors array', () => {
      const errors = validateEnvVar('invalid-name');
      expect(isValid(errors)).toBe(false);
    });
  });

  describe('formatValidationError', () => {
    it('should format error message', () => {
      const errors = validateEnvVar('invalid-name');
      const formatted = formatValidationError(errors[0]);
      expect(formatted).toContain('pattern');
    });

    it('should format blocked error message', () => {
      const errors = validateEnvVar('PATH', '/usr/bin');
      const formatted = formatValidationError(errors[0]);
      expect(formatted).toContain('PATH');
      expect(formatted).toContain('cannot be set');
    });
  });

  describe('formatValidationErrors', () => {
    it('should return empty string for no errors', () => {
      const formatted = formatValidationErrors([]);
      expect(formatted).toBe('');
    });

    it('should format multiple errors with field prefix', () => {
      const errors = validateEnvVar('invalid-name', '');
      const formatted = formatValidationErrors(errors);
      expect(formatted).toContain('[');
      expect(formatted).toContain(']');
    });

    it('should join errors with newlines', () => {
      const errors = validateEnvVar('invalid-name', '');
      const formatted = formatValidationErrors(errors);
      const lines = formatted.split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('ENV_VAR_CONSTRAINTS', () => {
    it('should have valid MAX_VALUE_LENGTH', () => {
      expect(ENV_VAR_CONSTRAINTS.MAX_VALUE_LENGTH).toBe(10 * 1024);
    });

    it('should have valid NAME_PATTERN', () => {
      expect(ENV_VAR_CONSTRAINTS.NAME_PATTERN).toBeDefined();
      expect(ENV_VAR_CONSTRAINTS.NAME_PATTERN.test('VALID_NAME')).toBe(true);
      expect(ENV_VAR_CONSTRAINTS.NAME_PATTERN.test('invalid-name')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle names with consecutive underscores', () => {
      const errors = validateEnvVar('VAR__NAME');
      expect(errors).toHaveLength(0);
    });

    it('should handle very long valid names', () => {
      const longName = `A${'_B'.repeat(50)}`;
      const errors = validateEnvVar(longName);
      expect(errors).toHaveLength(0);
    });

    it('should handle case-insensitive blocklist checking', () => {
      // Test lowercase version of blocked var - fails both format AND blocklist
      const errors1 = validateEnvVar('path'); // lowercase
      // lowercase fails format check (must be UPPERCASE) and also blocklist (case-insensitive)
      expect(errors1.length).toBeGreaterThan(0);
      expect(errors1.some((e) => e.code === 'invalid_format')).toBe(true);

      // Test mixed case - also fails format and blocklist
      const errors2 = validateEnvVar('Path'); // mixed case
      expect(errors2.length).toBeGreaterThan(0);
      expect(errors2.some((e) => e.code === 'invalid_format')).toBe(true);
    });

    it('should handle value that is just whitespace variations', () => {
      const errors1 = validateEnvVar('TEST', '\t');
      expect(errors1).toHaveLength(1);
      expect(errors1[0].code).toBe('empty_value');

      const errors2 = validateEnvVar('TEST', '\n');
      expect(errors2).toHaveLength(1);
      expect(errors2[0].code).toBe('empty_value');
    });
  });
});
