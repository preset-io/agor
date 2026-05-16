import { describe, expect, it } from 'vitest';
import type { Session, User, UserID } from '../types/index.js';
import {
  type ChildResolverParent,
  resolveChildSessionConfig,
} from './resolve-child-session-config.js';

const now = new Date('2026-05-09T00:00:00.000Z');

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

function makeParent(overrides: Partial<ChildResolverParent>): ChildResolverParent {
  return {
    agentic_tool: 'claude-code',
    permission_config: { mode: 'acceptEdits' },
    model_config: undefined,
    ...overrides,
  } as ChildResolverParent;
}

describe('resolveChildSessionConfig', () => {
  // --------------------------------------------------------------
  // The bug — spawn parent.tool=claude-code → child.tool=codex must
  // NOT carry parent's claude-opus-4-7 model into the codex child.
  // --------------------------------------------------------------
  describe('cross-tool spawn (regression: parent claude-code → child codex)', () => {
    const parent = makeParent({
      agentic_tool: 'claude-code',
      model_config: {
        mode: 'alias',
        model: 'claude-opus-4-7',
        updated_at: '2026-05-01T00:00:00.000Z',
      },
      permission_config: { mode: 'acceptEdits' },
    });

    it('does NOT inherit parent claude model when no user codex default exists', () => {
      const r = resolveChildSessionConfig({
        parent,
        effectiveTool: 'codex',
        user: makeUser({}), // no codex defaults, no claude defaults — empty
        now,
      });
      expect(r.model_config).toBeUndefined();
    });

    it('falls through to user codex default when present, not parent claude model', () => {
      const r = resolveChildSessionConfig({
        parent,
        effectiveTool: 'codex',
        user: makeUser({ codex: { modelConfig: { model: 'gpt-5.4' } } }),
        now,
      });
      expect(r.model_config?.model).toBe('gpt-5.4');
    });

    it('uses mapped codex permission default (allow-all), not parent acceptEdits', () => {
      const r = resolveChildSessionConfig({
        parent,
        effectiveTool: 'codex',
        user: makeUser({}),
        now,
      });
      expect(r.permission_config.mode).toBe('allow-all');
    });

    it('explicit override wins even on cross-tool spawn', () => {
      const r = resolveChildSessionConfig({
        parent,
        effectiveTool: 'codex',
        user: makeUser({ codex: { modelConfig: { model: 'gpt-5.4' } } }),
        overrides: { modelConfig: { model: 'gpt-5.4-mini' } },
        now,
      });
      expect(r.model_config?.model).toBe('gpt-5.4-mini');
    });
  });

  // --------------------------------------------------------------
  // Same-tool: parent's choices propagate (the desired existing behavior)
  // --------------------------------------------------------------
  describe('same-tool spawn (parent inheritance preserved)', () => {
    const parent = makeParent({
      agentic_tool: 'claude-code',
      model_config: {
        mode: 'alias',
        model: 'claude-opus-4-7',
        effort: 'high',
        updated_at: '2026-05-01T00:00:00.000Z',
      },
      permission_config: { mode: 'bypassPermissions' },
    });

    it('inherits parent model when child tool === parent tool', () => {
      const r = resolveChildSessionConfig({
        parent,
        effectiveTool: 'claude-code',
        user: makeUser({ 'claude-code': { modelConfig: { model: 'claude-sonnet-4-6' } } }),
        now,
      });
      // Parent wins over user default on same-tool spawns.
      expect(r.model_config?.model).toBe('claude-opus-4-7');
      expect(r.model_config?.effort).toBe('high');
    });

    it('inherits parent permission_config when child tool === parent tool', () => {
      const r = resolveChildSessionConfig({
        parent,
        effectiveTool: 'claude-code',
        user: makeUser({}),
        now,
      });
      expect(r.permission_config.mode).toBe('bypassPermissions');
    });

    it('explicit override beats parent inheritance', () => {
      const r = resolveChildSessionConfig({
        parent,
        effectiveTool: 'claude-code',
        overrides: {
          modelConfig: { model: 'claude-haiku-4-5' },
          permissionMode: 'plan',
        },
        now,
      });
      expect(r.model_config?.model).toBe('claude-haiku-4-5');
      expect(r.permission_config.mode).toBe('plan');
    });

    it('defaults effectiveTool to parent.agentic_tool when omitted', () => {
      const r = resolveChildSessionConfig({
        parent,
        user: makeUser({}),
        now,
      });
      // Same-tool path → inherits parent.
      expect(r.model_config?.model).toBe('claude-opus-4-7');
      expect(r.permission_config.mode).toBe('bypassPermissions');
    });
  });

  // --------------------------------------------------------------
  // Cross-tool with parent that HAS a model the new tool would accept:
  // we still don't inherit — model identity is tool-scoped by contract.
  // --------------------------------------------------------------
  describe('cross-tool spawn with no user default', () => {
    it('returns undefined model when neither parent (gated off) nor user default applies', () => {
      const parent = makeParent({
        agentic_tool: 'claude-code',
        model_config: {
          mode: 'alias',
          model: 'claude-opus-4-7',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      });
      const r = resolveChildSessionConfig({
        parent,
        effectiveTool: 'gemini',
        user: null,
        now,
      });
      expect(r.model_config).toBeUndefined();
      expect(r.permission_config.mode).toBe('autoEdit'); // gemini system default
    });

    it('returns mapped permission default when user is null', () => {
      const parent = makeParent({ agentic_tool: 'claude-code' });
      const r = resolveChildSessionConfig({
        parent,
        effectiveTool: 'codex',
        user: null,
        now,
      });
      expect(r.permission_config.mode).toBe('allow-all');
    });
  });

  // --------------------------------------------------------------
  // Codex sub-config gating — sandboxMode/approvalPolicy cross-tool rules
  // --------------------------------------------------------------
  describe('codex sub-config (cross-tool gate)', () => {
    it('cross-tool spawn does NOT inherit parent codex sub-config', () => {
      // Parent is codex with full sub-config. Child is claude-code.
      // The child must not carry codex sub-config (it would be meaningless on Claude).
      const parent = makeParent({
        agentic_tool: 'codex',
        permission_config: {
          mode: 'auto',
          codex: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
        },
      });
      const r = resolveChildSessionConfig({
        parent,
        effectiveTool: 'claude-code',
        user: makeUser({}),
        now,
      });
      expect(r.permission_config.codex).toBeUndefined();
    });

    it('same-tool spawn from codex parent inherits parent codex sub-config', () => {
      const parent = makeParent({
        agentic_tool: 'codex',
        permission_config: {
          mode: 'auto',
          codex: {
            sandboxMode: 'workspace-write',
            approvalPolicy: 'on-request',
            networkAccess: true,
          },
        },
      });
      const r = resolveChildSessionConfig({
        parent,
        effectiveTool: 'codex',
        user: makeUser({}),
        now,
      });
      expect(r.permission_config.codex).toEqual({
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        networkAccess: true,
      });
    });

    it('cross-tool spawn TO codex with no user default emits no codex sub-config', () => {
      // User has no codex defaults → no sandboxMode + approvalPolicy pair → no sub-config.
      // The mapped permission mode still resolves (to 'allow-all').
      const parent = makeParent({ agentic_tool: 'claude-code' });
      const r = resolveChildSessionConfig({
        parent,
        effectiveTool: 'codex',
        user: makeUser({}),
        now,
      });
      expect(r.permission_config.mode).toBe('allow-all');
      expect(r.permission_config.codex).toBeUndefined();
    });

    it('cross-tool spawn TO codex with user codex defaults includes sub-config', () => {
      const parent = makeParent({ agentic_tool: 'claude-code' });
      const r = resolveChildSessionConfig({
        parent,
        effectiveTool: 'codex',
        user: makeUser({
          codex: {
            permissionMode: 'auto',
            codexSandboxMode: 'read-only',
            codexApprovalPolicy: 'untrusted',
            codexNetworkAccess: false,
          },
        }),
        now,
      });
      expect(r.permission_config.codex).toEqual({
        sandboxMode: 'read-only',
        approvalPolicy: 'untrusted',
        networkAccess: false,
      });
    });

    it('explicit codex sub-config overrides parent sub-config (same tool)', () => {
      const parent = makeParent({
        agentic_tool: 'codex',
        permission_config: {
          mode: 'auto',
          codex: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
        },
      });
      const r = resolveChildSessionConfig({
        parent,
        effectiveTool: 'codex',
        overrides: {
          codexSandboxMode: 'read-only',
          codexApprovalPolicy: 'untrusted',
          codexNetworkAccess: false,
        },
        now,
      });
      expect(r.permission_config.codex).toEqual({
        sandboxMode: 'read-only',
        approvalPolicy: 'untrusted',
        networkAccess: false,
      });
    });
  });

  // --------------------------------------------------------------
  // Permission-mode mapping across tools
  // --------------------------------------------------------------
  describe('permission_mode mapping', () => {
    it('claude→gemini cross-tool maps user-default acceptEdits to autoEdit', () => {
      const parent = makeParent({ agentic_tool: 'claude-code' });
      const r = resolveChildSessionConfig({
        parent,
        effectiveTool: 'gemini',
        // user has Gemini defaults stored as Claude mode (legacy/edge case).
        user: makeUser({ gemini: { permissionMode: 'acceptEdits' } }),
        now,
      });
      expect(r.permission_config.mode).toBe('autoEdit');
    });

    it('claude→codex cross-tool with user default acceptEdits maps to auto', () => {
      const parent = makeParent({ agentic_tool: 'claude-code' });
      const r = resolveChildSessionConfig({
        parent,
        effectiveTool: 'codex',
        user: makeUser({ codex: { permissionMode: 'acceptEdits' } }),
        now,
      });
      expect(r.permission_config.mode).toBe('auto');
    });
  });
});

// Sanity check that the helper compiles against the real `Session` shape too.
describe('resolveChildSessionConfig type compatibility', () => {
  it('accepts a full Session as parent', () => {
    const fakeSession = {
      agentic_tool: 'claude-code' as const,
      permission_config: { mode: 'acceptEdits' as const },
      model_config: undefined,
    } satisfies Pick<Session, 'agentic_tool' | 'permission_config' | 'model_config'>;
    const r = resolveChildSessionConfig({ parent: fakeSession, now });
    expect(r.permission_config.mode).toBe('acceptEdits');
  });
});
