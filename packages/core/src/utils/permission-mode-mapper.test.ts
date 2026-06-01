/**
 * Permission Mode Mapper Tests
 *
 * Tests cross-agent permission mode mapping. Each agent now uses native modes,
 * and this mapper only comes into play when spawning sessions of different types.
 */

import { describe, expect, it } from 'vitest';
import {
  getDefaultCodexPermissionConfig,
  mapPermissionMode,
  mapToCodexPermissionConfig,
} from './permission-mode-mapper';

describe('mapPermissionMode', () => {
  describe('Claude Code', () => {
    it('passes through native Claude modes unchanged', () => {
      expect(mapPermissionMode('default', 'claude-code')).toBe('default');
      expect(mapPermissionMode('acceptEdits', 'claude-code')).toBe('acceptEdits');
      expect(mapPermissionMode('bypassPermissions', 'claude-code')).toBe('bypassPermissions');
      expect(mapPermissionMode('plan', 'claude-code')).toBe('plan');
      expect(mapPermissionMode('dontAsk', 'claude-code')).toBe('dontAsk');
    });

    it('maps Gemini modes to Claude equivalents', () => {
      expect(mapPermissionMode('autoEdit', 'claude-code')).toBe('acceptEdits');
      expect(mapPermissionMode('yolo', 'claude-code')).toBe('bypassPermissions');
    });

    it('maps Codex modes to Claude equivalents', () => {
      expect(mapPermissionMode('ask', 'claude-code')).toBe('default');
      expect(mapPermissionMode('auto', 'claude-code')).toBe('acceptEdits');
      expect(mapPermissionMode('on-failure', 'claude-code')).toBe('acceptEdits');
      expect(mapPermissionMode('allow-all', 'claude-code')).toBe('bypassPermissions');
    });
  });

  describe('Gemini / OpenCode', () => {
    it('passes through native Gemini modes unchanged', () => {
      expect(mapPermissionMode('default', 'gemini')).toBe('default');
      expect(mapPermissionMode('autoEdit', 'gemini')).toBe('autoEdit');
      expect(mapPermissionMode('yolo', 'gemini')).toBe('yolo');
    });

    it('maps Claude modes to Gemini equivalents', () => {
      expect(mapPermissionMode('acceptEdits', 'gemini')).toBe('autoEdit');
      expect(mapPermissionMode('bypassPermissions', 'gemini')).toBe('yolo');
      expect(mapPermissionMode('dontAsk', 'gemini')).toBe('yolo');
      expect(mapPermissionMode('plan', 'gemini')).toBe('default');
    });

    it('maps Codex modes to Gemini equivalents', () => {
      expect(mapPermissionMode('ask', 'gemini')).toBe('default');
      expect(mapPermissionMode('auto', 'gemini')).toBe('autoEdit');
      expect(mapPermissionMode('on-failure', 'gemini')).toBe('autoEdit');
      expect(mapPermissionMode('allow-all', 'gemini')).toBe('yolo');
    });

    it('works the same for OpenCode', () => {
      expect(mapPermissionMode('autoEdit', 'opencode')).toBe('autoEdit');
      expect(mapPermissionMode('acceptEdits', 'opencode')).toBe('autoEdit');
    });
  });

  describe('Codex', () => {
    it('passes through native Codex modes unchanged', () => {
      expect(mapPermissionMode('ask', 'codex')).toBe('ask');
      expect(mapPermissionMode('auto', 'codex')).toBe('auto');
      expect(mapPermissionMode('on-failure', 'codex')).toBe('on-failure');
      expect(mapPermissionMode('allow-all', 'codex')).toBe('allow-all');
    });

    it('maps Claude modes to Codex equivalents', () => {
      expect(mapPermissionMode('default', 'codex')).toBe('ask');
      expect(mapPermissionMode('acceptEdits', 'codex')).toBe('auto');
      expect(mapPermissionMode('bypassPermissions', 'codex')).toBe('allow-all');
      expect(mapPermissionMode('dontAsk', 'codex')).toBe('allow-all');
      expect(mapPermissionMode('plan', 'codex')).toBe('ask');
    });

    it('maps Gemini modes to Codex equivalents', () => {
      expect(mapPermissionMode('autoEdit', 'codex')).toBe('auto');
      expect(mapPermissionMode('yolo', 'codex')).toBe('allow-all');
    });
  });
});

describe('mapToCodexPermissionConfig', () => {
  it('maps ask mode to read-only + untrusted + network off', () => {
    expect(mapToCodexPermissionConfig('ask')).toEqual({
      sandboxMode: 'read-only',
      approvalPolicy: 'untrusted',
      networkAccess: false,
    });
  });

  it('maps auto mode to workspace-write + on-request + network off', () => {
    expect(mapToCodexPermissionConfig('auto')).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      networkAccess: false,
    });
  });

  it('maps on-failure mode to workspace-write + on-failure + network off', () => {
    expect(mapToCodexPermissionConfig('on-failure')).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-failure',
      networkAccess: false,
    });
  });

  it('maps allow-all mode to workspace-write + never + network on', () => {
    // The only "sandbox is the defense" mode that gets network on by default.
    expect(mapToCodexPermissionConfig('allow-all')).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      networkAccess: true,
    });
  });

  it('maps Claude modes through conversion', () => {
    expect(mapToCodexPermissionConfig('default')).toEqual({
      sandboxMode: 'read-only',
      approvalPolicy: 'untrusted',
      networkAccess: false,
    });
    expect(mapToCodexPermissionConfig('acceptEdits')).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      networkAccess: false,
    });
    expect(mapToCodexPermissionConfig('bypassPermissions')).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      networkAccess: true,
    });
  });

  it('maps Gemini modes through conversion', () => {
    expect(mapToCodexPermissionConfig('autoEdit')).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      networkAccess: false,
    });
    expect(mapToCodexPermissionConfig('yolo')).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      networkAccess: true,
    });
  });
});

describe('getDefaultCodexPermissionConfig', () => {
  it('returns the codex sub-config for the system default mode', () => {
    // System default is currently 'allow-all' — should track that source of truth.
    expect(getDefaultCodexPermissionConfig()).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      networkAccess: true,
    });
  });
});
