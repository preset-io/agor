/**
 * Permission Mode Mapper Tests
 *
 * Tests cross-agent permission mode mapping. Each agent now uses native modes,
 * and this mapper only comes into play when spawning sessions of different types.
 */

import { describe, expect, it } from 'vitest';
import { mapPermissionMode, mapToCodexPermissionConfig } from './permission-mode-mapper';

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

  it('maps Gemini modes through conversion', () => {
    // autoEdit → auto → workspace-write + on-request
    const autoEditConfig = mapToCodexPermissionConfig('autoEdit');
    expect(autoEditConfig.sandboxMode).toBe('workspace-write');
    expect(autoEditConfig.approvalPolicy).toBe('on-request');

    // yolo → allow-all → workspace-write + never
    const yoloConfig = mapToCodexPermissionConfig('yolo');
    expect(yoloConfig.sandboxMode).toBe('workspace-write');
    expect(yoloConfig.approvalPolicy).toBe('never');
  });
});
