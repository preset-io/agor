import { describe, expect, it } from 'vitest';
import type { User, UserID } from '../types/index.js';
import { resolveSessionDefaults } from './resolve-session-defaults.js';

const now = new Date('2026-05-03T00:00:00.000Z');

function makeUser(partial: Partial<User['default_agentic_config']> = {}): User {
  return {
    user_id: 'user-1' as UserID,
    email: 'a@b.c',
    role: 'member',
    onboarding_completed: true,
    must_change_password: false,
    created_at: new Date(),
    scheduled_from_worktree: false,
    default_agentic_config: partial,
  } as unknown as User;
}

describe('resolveSessionDefaults', () => {
  describe('permission_config', () => {
    it('falls back to system default when nothing else is set', () => {
      const r = resolveSessionDefaults({ agenticTool: 'claude-code' });
      expect(r.permission_config).toEqual({ mode: 'acceptEdits' });
    });

    it("uses the user's tool default when present", () => {
      const r = resolveSessionDefaults({
        agenticTool: 'claude-code',
        user: makeUser({ 'claude-code': { permissionMode: 'bypassPermissions' } }),
      });
      expect(r.permission_config.mode).toBe('bypassPermissions');
    });

    it('explicit override wins over user default', () => {
      const r = resolveSessionDefaults({
        agenticTool: 'claude-code',
        user: makeUser({ 'claude-code': { permissionMode: 'bypassPermissions' } }),
        overrides: { permissionMode: 'plan' },
      });
      expect(r.permission_config.mode).toBe('plan');
    });

    it('maps cross-agent modes through mapPermissionMode', () => {
      // User stored a Claude mode but the target tool is Gemini → must map.
      const r = resolveSessionDefaults({
        agenticTool: 'gemini',
        user: makeUser({ gemini: { permissionMode: 'bypassPermissions' } }),
      });
      expect(r.permission_config.mode).toBe('yolo');
    });

    it('emits codex sub-config when sandboxMode + approvalPolicy both present (user defaults)', () => {
      const r = resolveSessionDefaults({
        agenticTool: 'codex',
        user: makeUser({
          codex: {
            permissionMode: 'auto',
            codexSandboxMode: 'workspace-write',
            codexApprovalPolicy: 'on-request',
            codexNetworkAccess: false,
          },
        }),
      });
      expect(r.permission_config.codex).toEqual({
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        networkAccess: false,
      });
    });

    it('explicit codex sub-config overrides user defaults', () => {
      const r = resolveSessionDefaults({
        agenticTool: 'codex',
        user: makeUser({
          codex: {
            permissionMode: 'auto',
            codexSandboxMode: 'workspace-write',
            codexApprovalPolicy: 'on-request',
          },
        }),
        overrides: {
          codexSandboxMode: 'read-only',
          codexApprovalPolicy: 'untrusted',
          codexNetworkAccess: true,
        },
      });
      expect(r.permission_config.codex).toEqual({
        sandboxMode: 'read-only',
        approvalPolicy: 'untrusted',
        networkAccess: true,
      });
    });

    it('omits codex sub-config for non-codex tools', () => {
      const r = resolveSessionDefaults({
        agenticTool: 'claude-code',
        overrides: { codexSandboxMode: 'read-only', codexApprovalPolicy: 'untrusted' },
      });
      expect(r.permission_config.codex).toBeUndefined();
    });
  });

  describe('model_config', () => {
    it('returns undefined when no model is configured anywhere', () => {
      const r = resolveSessionDefaults({ agenticTool: 'claude-code', now });
      expect(r.model_config).toBeUndefined();
    });

    it("uses the user's tool default model when present", () => {
      const r = resolveSessionDefaults({
        agenticTool: 'claude-code',
        user: makeUser({ 'claude-code': { modelConfig: { model: 'claude-sonnet-4-6' } } }),
        now,
      });
      expect(r.model_config?.model).toBe('claude-sonnet-4-6');
      expect(r.model_config?.updated_at).toBe(now.toISOString());
    });

    it('explicit override wins over user default (no field merging)', () => {
      const r = resolveSessionDefaults({
        agenticTool: 'claude-code',
        user: makeUser({
          'claude-code': { modelConfig: { model: 'claude-sonnet-4-6', effort: 'high' } },
        }),
        overrides: { modelConfig: { model: 'claude-opus-4-6' } },
        now,
      });
      expect(r.model_config?.model).toBe('claude-opus-4-6');
      // first-wins, not merge — must NOT inherit effort from user default
      expect(r.model_config).not.toHaveProperty('effort');
    });
  });

  describe('mcp_server_ids', () => {
    it('explicit override wins, including empty array (= "no MCPs")', () => {
      const r = resolveSessionDefaults({
        agenticTool: 'claude-code',
        user: makeUser({ 'claude-code': { mcpServerIds: ['user-1', 'user-2'] } }),
        worktree: { mcp_server_ids: ['wt-1'] },
        overrides: { mcpServerIds: [] },
      });
      expect(r.mcp_server_ids).toEqual([]);
    });

    it('worktree config wins over user defaults when no override', () => {
      const r = resolveSessionDefaults({
        agenticTool: 'claude-code',
        user: makeUser({ 'claude-code': { mcpServerIds: ['user-1'] } }),
        worktree: { mcp_server_ids: ['wt-1'] },
      });
      expect(r.mcp_server_ids).toEqual(['wt-1']);
    });

    it('falls through to user defaults when worktree has no config', () => {
      const r = resolveSessionDefaults({
        agenticTool: 'claude-code',
        user: makeUser({ 'claude-code': { mcpServerIds: ['user-1'] } }),
        worktree: { mcp_server_ids: [] },
      });
      expect(r.mcp_server_ids).toEqual(['user-1']);
    });

    it('returns empty array when nothing is configured anywhere', () => {
      const r = resolveSessionDefaults({ agenticTool: 'claude-code' });
      expect(r.mcp_server_ids).toEqual([]);
    });
  });

  describe('regression: issue #1064', () => {
    it("a Claude session with user default 'bypassPermissions' resolves to bypassPermissions, not the most restrictive default", () => {
      // Previously the UI drag-into-zone path created sessions with
      // permission_config: null, which Claude Code interprets as "ask for
      // every tool". With the helper + before:create hook, the user's
      // saved default is honored.
      const r = resolveSessionDefaults({
        agenticTool: 'claude-code',
        user: makeUser({ 'claude-code': { permissionMode: 'bypassPermissions' } }),
      });
      expect(r.permission_config.mode).toBe('bypassPermissions');
    });
  });
});
