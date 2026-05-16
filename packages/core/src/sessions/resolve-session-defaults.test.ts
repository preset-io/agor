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
      expect(r.permission_config).toEqual({ mode: 'bypassPermissions' });
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

    it('emits full codex sub-config from user defaults', () => {
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

    it('always emits codex sub-config for codex sessions, filling missing fields from the mapped mode', () => {
      // No user defaults — sub-config should be filled from
      // mapToCodexPermissionConfig(getDefaultPermissionMode('codex')).
      const r = resolveSessionDefaults({ agenticTool: 'codex' });
      expect(r.permission_config).toEqual({
        mode: 'allow-all',
        codex: {
          sandboxMode: 'workspace-write',
          approvalPolicy: 'never',
          networkAccess: true,
        },
      });
    });

    it("partial user defaults are preserved; missing fields fill from the user's mode (regression: don't escalate to system default)", () => {
      // User explicitly chose a stricter approval policy but didn't set
      // sandboxMode or networkAccess. Pre-fix this dropped the sub-config
      // entirely and the executor fallback escalated approval to 'never'.
      const r = resolveSessionDefaults({
        agenticTool: 'codex',
        user: makeUser({
          codex: { permissionMode: 'ask', codexApprovalPolicy: 'untrusted' },
        }),
      });
      expect(r.permission_config).toEqual({
        mode: 'ask',
        codex: {
          // sandboxMode + networkAccess fill from mapToCodexPermissionConfig('ask')
          sandboxMode: 'read-only',
          approvalPolicy: 'untrusted',
          networkAccess: false,
        },
      });
    });

    it('partial user defaults (only sandboxMode) — approvalPolicy + networkAccess fill from mode', () => {
      const r = resolveSessionDefaults({
        agenticTool: 'codex',
        user: makeUser({
          codex: { codexSandboxMode: 'read-only' },
        }),
      });
      expect(r.permission_config.codex).toEqual({
        sandboxMode: 'read-only',
        approvalPolicy: 'never', // from default mode 'allow-all'
        networkAccess: true, // from default mode 'allow-all'
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

  describe('cross-tool spawn fallback (covers SessionsService.spawn)', () => {
    // Regression coverage for the spawn() cross-tool change in 7992a712:
    // when the user has NO default for the target tool, the spawn path now
    // adopts the helper's resolved values instead of partially keeping the
    // parent's. Verify the helper produces sensible output for that case.

    it('cross-tool spawn with no user default for target tool: returns mapped system default permission mode', () => {
      // User has Claude defaults but is spawning a Codex child. There's no
      // codex entry in default_agentic_config, so we should fall back to
      // codex's system default ('allow-all'), not to whatever the parent had.
      const r = resolveSessionDefaults({
        agenticTool: 'codex',
        user: makeUser({ 'claude-code': { permissionMode: 'bypassPermissions' } }),
      });
      expect(r.permission_config.mode).toBe('allow-all');
    });

    it('cross-tool spawn from Claude → Gemini with no user default: returns gemini system default', () => {
      const r = resolveSessionDefaults({
        agenticTool: 'gemini',
        user: makeUser({ 'claude-code': { permissionMode: 'acceptEdits' } }),
      });
      expect(r.permission_config.mode).toBe('autoEdit');
    });

    it('cross-tool spawn with no user at all: returns system default and is non-null', () => {
      // The helper is called from the catch branch in spawn() when the user
      // lookup fails. Ensure it still returns a populated permission_config.
      const r = resolveSessionDefaults({ agenticTool: 'codex' });
      expect(r.permission_config).toBeDefined();
      expect(r.permission_config.mode).toBe('allow-all');
    });
  });

  describe('gateway-style overrides (covers GatewayService channel config)', () => {
    // Regression coverage for 7992a712: gateway now threads codex sub-config
    // and mcpServerIds from GatewayAgenticConfig through the helper. Verify
    // that the full set of fields is honored as a single bundle.

    it('threads codex sub-config + mcp ids + permission/model overrides together', () => {
      const r = resolveSessionDefaults({
        agenticTool: 'codex',
        user: makeUser({
          codex: {
            permissionMode: 'auto',
            codexSandboxMode: 'workspace-write',
            codexApprovalPolicy: 'on-request',
            mcpServerIds: ['user-mcp'],
          },
        }),
        overrides: {
          // Simulates GatewayAgenticConfig fully populated by a Slack channel.
          permissionMode: 'auto',
          codexSandboxMode: 'danger-full-access',
          codexApprovalPolicy: 'never',
          codexNetworkAccess: true,
          mcpServerIds: ['gateway-mcp-1', 'gateway-mcp-2'],
        },
      });
      expect(r.permission_config.mode).toBe('auto');
      expect(r.permission_config.codex).toEqual({
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        networkAccess: true,
      });
      expect(r.mcp_server_ids).toEqual(['gateway-mcp-1', 'gateway-mcp-2']);
    });
  });
});
