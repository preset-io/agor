/**
 * Permission Mode Mapper Tests
 */

import { describe, expect, it } from 'vitest';
import { mapPermissionMode, mapToCodexPermissionConfig } from './permission-mode-mapper';

describe('mapPermissionMode', () => {
  describe('Claude Code / Cursor / Gemini', () => {
    it('passes through native Claude modes unchanged', () => {
      expect(mapPermissionMode('default', 'claude-code')).toBe('default');
      expect(mapPermissionMode('acceptEdits', 'claude-code')).toBe('acceptEdits');
      expect(mapPermissionMode('bypassPermissions', 'claude-code')).toBe('bypassPermissions');
      expect(mapPermissionMode('plan', 'claude-code')).toBe('plan');
    });

    it('maps Codex modes to Claude equivalents', () => {
      expect(mapPermissionMode('ask', 'claude-code')).toBe('default');
      expect(mapPermissionMode('auto', 'claude-code')).toBe('acceptEdits');
      expect(mapPermissionMode('on-failure', 'claude-code')).toBe('acceptEdits');
      expect(mapPermissionMode('allow-all', 'claude-code')).toBe('bypassPermissions');
    });

    it('works the same for Cursor and Gemini', () => {
      expect(mapPermissionMode('ask', 'cursor')).toBe('default');
      expect(mapPermissionMode('auto', 'gemini')).toBe('acceptEdits');
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
      expect(mapPermissionMode('plan', 'codex')).toBe('ask'); // Most restrictive for Claude-specific mode
    });
  });
});

describe('mapToCodexPermissionConfig', () => {
  it('maps ask mode to read-only + untrusted', () => {
    const config = mapToCodexPermissionConfig('ask');
    expect(config.sandboxMode).toBe('read-only');
    expect(config.approvalPolicy).toBe('untrusted');
  });

  it('maps auto mode to workspace-write + on-request', () => {
    const config = mapToCodexPermissionConfig('auto');
    expect(config.sandboxMode).toBe('workspace-write');
    expect(config.approvalPolicy).toBe('on-request');
  });

  it('maps on-failure mode to workspace-write + on-failure', () => {
    const config = mapToCodexPermissionConfig('on-failure');
    expect(config.sandboxMode).toBe('workspace-write');
    expect(config.approvalPolicy).toBe('on-failure');
  });

  it('maps allow-all mode to workspace-write + never', () => {
    const config = mapToCodexPermissionConfig('allow-all');
    expect(config.sandboxMode).toBe('workspace-write');
    expect(config.approvalPolicy).toBe('never');
  });

  it('maps Claude modes through conversion', () => {
    // default → ask → read-only + untrusted
    const defaultConfig = mapToCodexPermissionConfig('default');
    expect(defaultConfig.sandboxMode).toBe('read-only');
    expect(defaultConfig.approvalPolicy).toBe('untrusted');

    // acceptEdits → auto → workspace-write + on-request
    const acceptEditsConfig = mapToCodexPermissionConfig('acceptEdits');
    expect(acceptEditsConfig.sandboxMode).toBe('workspace-write');
    expect(acceptEditsConfig.approvalPolicy).toBe('on-request');

    // bypassPermissions → allow-all → workspace-write + never
    const bypassConfig = mapToCodexPermissionConfig('bypassPermissions');
    expect(bypassConfig.sandboxMode).toBe('workspace-write');
    expect(bypassConfig.approvalPolicy).toBe('never');
  });
});
