import { ApprovalMode } from '@google/gemini-cli-core';
import { describe, expect, it } from 'vitest';
import type { PermissionMode } from '../../types';
import { mapPermissionMode } from './permission-mapper';

describe('mapPermissionMode', () => {
  describe('Basic Mappings', () => {
    it('should map "default" to ApprovalMode.DEFAULT', () => {
      expect(mapPermissionMode('default')).toBe(ApprovalMode.DEFAULT);
    });

    it('should map "ask" to ApprovalMode.DEFAULT', () => {
      expect(mapPermissionMode('ask')).toBe(ApprovalMode.DEFAULT);
    });

    it('should map "acceptEdits" to ApprovalMode.YOLO (temporary mapping)', () => {
      // NOTE: Currently mapped to YOLO as per TODO in source
      expect(mapPermissionMode('acceptEdits')).toBe(ApprovalMode.YOLO);
    });

    it('should map "auto" to ApprovalMode.YOLO (temporary mapping)', () => {
      // NOTE: Currently mapped to YOLO as per TODO in source
      expect(mapPermissionMode('auto')).toBe(ApprovalMode.YOLO);
    });

    it('should map "bypassPermissions" to ApprovalMode.YOLO', () => {
      expect(mapPermissionMode('bypassPermissions')).toBe(ApprovalMode.YOLO);
    });

    it('should map "allow-all" to ApprovalMode.YOLO', () => {
      expect(mapPermissionMode('allow-all')).toBe(ApprovalMode.YOLO);
    });
  });

  describe('Unknown and Cross-Tool Modes', () => {
    it('should default to ApprovalMode.DEFAULT for unknown modes', () => {
      expect(mapPermissionMode('unknown-mode' as PermissionMode)).toBe(ApprovalMode.DEFAULT);
    });

    it('should map "on-failure" mode (Codex-specific) to DEFAULT', () => {
      // on-failure is not explicitly handled in Gemini, should use default
      expect(mapPermissionMode('on-failure' as PermissionMode)).toBe(ApprovalMode.DEFAULT);
    });

    it('should map "plan" mode (Claude-specific) to DEFAULT', () => {
      // plan is not explicitly handled in Gemini, should use default
      expect(mapPermissionMode('plan' as PermissionMode)).toBe(ApprovalMode.DEFAULT);
    });
  });

  describe('Edge Cases', () => {
    it('should handle null permission mode with default', () => {
      expect(mapPermissionMode(null as any)).toBe(ApprovalMode.DEFAULT);
    });

    it('should handle undefined permission mode with default', () => {
      expect(mapPermissionMode(undefined as any)).toBe(ApprovalMode.DEFAULT);
    });

    it('should handle empty string permission mode with default', () => {
      expect(mapPermissionMode('' as any)).toBe(ApprovalMode.DEFAULT);
    });

    it('should handle case-sensitive permission modes', () => {
      // These should not match and return default
      expect(mapPermissionMode('ASK' as any)).toBe(ApprovalMode.DEFAULT);
      expect(mapPermissionMode('Default' as any)).toBe(ApprovalMode.DEFAULT);
      expect(mapPermissionMode('ALLOW-ALL' as any)).toBe(ApprovalMode.DEFAULT);
    });
  });

  describe('Comprehensive Coverage', () => {
    it('should handle all Agor PermissionMode values', () => {
      const modes: PermissionMode[] = [
        'default',
        'acceptEdits',
        'bypassPermissions',
        'plan',
        'ask',
        'auto',
        'on-failure',
        'allow-all',
      ];

      for (const mode of modes) {
        const result = mapPermissionMode(mode);
        expect(Object.values(ApprovalMode)).toContain(result);
      }
    });

    it('should return consistent mappings for same input', () => {
      const result1 = mapPermissionMode('ask');
      const result2 = mapPermissionMode('ask');
      expect(result1).toBe(result2);
      expect(result1).toBe(ApprovalMode.DEFAULT);
    });

    it('should be a pure function (no side effects)', () => {
      const mode: PermissionMode = 'auto';
      const result1 = mapPermissionMode(mode);
      const result2 = mapPermissionMode(mode);
      const result3 = mapPermissionMode(mode);

      expect(result1).toBe(result2);
      expect(result2).toBe(result3);
    });
  });

  describe('ApprovalMode Enum Values', () => {
    it('should return valid ApprovalMode.DEFAULT value', () => {
      const result = mapPermissionMode('default');
      expect(result).toBe(ApprovalMode.DEFAULT);
      expect(result).toBe('default');
    });

    it('should return valid ApprovalMode.YOLO value', () => {
      const result = mapPermissionMode('allow-all');
      expect(result).toBe(ApprovalMode.YOLO);
      expect(result).toBe('yolo');
    });
  });

  describe('Security and Safety', () => {
    it('should default to most restrictive mode for unknown inputs', () => {
      const unknownInputs = ['malicious-input', 'bypass-all', 'sudo', 'root', '../../etc/passwd'];

      for (const input of unknownInputs) {
        const result = mapPermissionMode(input as PermissionMode);
        expect(result).toBe(ApprovalMode.DEFAULT);
      }
    });

    it('should not allow privilege escalation through typos', () => {
      // Common typos should default to safest mode
      const typos = [
        'allowAll', // camelCase instead of kebab-case
        'allow_all', // snake_case instead of kebab-case
        'allowall', // no separator
        'allow all', // space instead of hyphen
      ];

      for (const typo of typos) {
        const result = mapPermissionMode(typo as PermissionMode);
        expect(result).toBe(ApprovalMode.DEFAULT);
      }
    });
  });
});
