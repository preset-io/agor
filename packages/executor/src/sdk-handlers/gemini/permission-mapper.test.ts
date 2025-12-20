import { Gemini } from '@agor/core/sdk';
import type { GeminiPermissionMode } from '@agor/core/types';
import { getDefaultPermissionMode } from '@agor/core/types';

const { ApprovalMode } = Gemini;

import { describe, expect, it } from 'vitest';
import { GEMINI_DEFAULT_PERMISSION_MODE, mapPermissionMode } from './permission-mapper.js';

describe('mapPermissionMode', () => {
  describe('Native Gemini Mode Mappings', () => {
    it('should map "default" to ApprovalMode.DEFAULT', () => {
      expect(mapPermissionMode('default')).toBe(ApprovalMode.DEFAULT);
    });

    it('should map "autoEdit" to ApprovalMode.AUTO_EDIT', () => {
      expect(mapPermissionMode('autoEdit')).toBe(ApprovalMode.AUTO_EDIT);
    });

    it('should map "yolo" to ApprovalMode.YOLO', () => {
      expect(mapPermissionMode('yolo')).toBe(ApprovalMode.YOLO);
    });
  });

  describe('Centralized Default', () => {
    it('should export GEMINI_DEFAULT_PERMISSION_MODE matching core getDefaultPermissionMode', () => {
      expect(GEMINI_DEFAULT_PERMISSION_MODE).toBe(getDefaultPermissionMode('gemini'));
      expect(GEMINI_DEFAULT_PERMISSION_MODE).toBe('autoEdit');
    });

    it('should fallback to centralized default for unknown modes', () => {
      const expectedDefault = mapPermissionMode(GEMINI_DEFAULT_PERMISSION_MODE);
      expect(mapPermissionMode('unknown-mode')).toBe(expectedDefault);
    });

    it('should fallback to centralized default for undefined', () => {
      const expectedDefault = mapPermissionMode(GEMINI_DEFAULT_PERMISSION_MODE);
      expect(mapPermissionMode(undefined)).toBe(expectedDefault);
    });

    it('should fallback to centralized default for empty string', () => {
      const expectedDefault = mapPermissionMode(GEMINI_DEFAULT_PERMISSION_MODE);
      expect(mapPermissionMode('')).toBe(expectedDefault);
    });
  });

  describe('Legacy Mode Fallback', () => {
    it('should fallback to centralized default for legacy "acceptEdits" mode', () => {
      // Legacy Claude Code mode should fallback to Gemini default
      const expectedDefault = mapPermissionMode(GEMINI_DEFAULT_PERMISSION_MODE);
      expect(mapPermissionMode('acceptEdits')).toBe(expectedDefault);
    });

    it('should fallback to centralized default for legacy "bypassPermissions" mode', () => {
      // Legacy Claude Code mode should fallback to Gemini default
      const expectedDefault = mapPermissionMode(GEMINI_DEFAULT_PERMISSION_MODE);
      expect(mapPermissionMode('bypassPermissions')).toBe(expectedDefault);
    });

    it('should fallback to centralized default for legacy "ask" mode', () => {
      // Legacy Codex mode should fallback to Gemini default
      const expectedDefault = mapPermissionMode(GEMINI_DEFAULT_PERMISSION_MODE);
      expect(mapPermissionMode('ask')).toBe(expectedDefault);
    });

    it('should fallback to centralized default for legacy "allow-all" mode', () => {
      // Legacy Codex mode should fallback to Gemini default
      const expectedDefault = mapPermissionMode(GEMINI_DEFAULT_PERMISSION_MODE);
      expect(mapPermissionMode('allow-all')).toBe(expectedDefault);
    });
  });

  describe('Case Sensitivity', () => {
    it('should be case-sensitive (wrong case returns centralized default)', () => {
      const expectedDefault = mapPermissionMode(GEMINI_DEFAULT_PERMISSION_MODE);
      // These should not match and return the centralized default
      expect(mapPermissionMode('DEFAULT')).toBe(expectedDefault);
      expect(mapPermissionMode('AutoEdit')).toBe(expectedDefault);
      expect(mapPermissionMode('YOLO')).toBe(expectedDefault);
    });
  });

  describe('Comprehensive Coverage', () => {
    it('should handle all native Gemini permission modes', () => {
      const modes: GeminiPermissionMode[] = ['default', 'autoEdit', 'yolo'];

      for (const mode of modes) {
        const result = mapPermissionMode(mode);
        expect(Object.values(ApprovalMode)).toContain(result);
      }
    });

    it('should return consistent mappings for same input', () => {
      const result1 = mapPermissionMode('autoEdit');
      const result2 = mapPermissionMode('autoEdit');
      expect(result1).toBe(result2);
      expect(result1).toBe(ApprovalMode.AUTO_EDIT);
    });
  });

  describe('ApprovalMode Enum Values', () => {
    it('should return valid ApprovalMode.DEFAULT value', () => {
      const result = mapPermissionMode('default');
      expect(result).toBe(ApprovalMode.DEFAULT);
      expect(result).toBe('default');
    });

    it('should return valid ApprovalMode.AUTO_EDIT value', () => {
      const result = mapPermissionMode('autoEdit');
      expect(result).toBe(ApprovalMode.AUTO_EDIT);
      expect(result).toBe('autoEdit');
    });

    it('should return valid ApprovalMode.YOLO value', () => {
      const result = mapPermissionMode('yolo');
      expect(result).toBe(ApprovalMode.YOLO);
      expect(result).toBe('yolo');
    });
  });

  describe('Security', () => {
    it('should fallback to centralized default for unknown/malicious inputs', () => {
      const unknownInputs = ['malicious-input', 'bypass-all', 'sudo', 'root'];
      const expectedDefault = mapPermissionMode(GEMINI_DEFAULT_PERMISSION_MODE);

      for (const input of unknownInputs) {
        const result = mapPermissionMode(input);
        expect(result).toBe(expectedDefault);
      }
    });
  });
});
