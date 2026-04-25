/**
 * Regression tests for hooks registered in register-hooks.ts.
 *
 * Covers the sessions.patch permission branching introduced to fix the bug
 * where a user with `session`-tier permission on a worktree could not prompt
 * their own session because the /sessions/:id/prompt route issues an internal
 * `{ tasks: [...] }` patch that was being gated behind `all`-tier.
 *
 * The branching logic in register-hooks.ts looks like:
 *
 *   if (isPromptFlowPatchOnly(context.data)) {
 *     → ensureCanPromptInSession (session-tier for own, prompt-tier otherwise)
 *   } else {
 *     → ensureWorktreePermission('all')   // metadata writes
 *   }
 *
 * The two downstream hooks are covered elsewhere (see
 * worktree-authorization.test.ts), so here we only verify the classifier.
 */

import { describe, expect, it } from 'vitest';
import {
  canReceiveMcpTokenForSession,
  isPromptFlowPatchOnly,
  PROMPT_FLOW_PATCH_FIELDS,
} from './register-hooks';

describe('isPromptFlowPatchOnly', () => {
  describe('accepts whitelisted-only patches', () => {
    it.each(
      PROMPT_FLOW_PATCH_FIELDS.map((f) => [f])
    )('accepts single whitelisted field: %s', (field) => {
      expect(isPromptFlowPatchOnly({ [field]: 'any-value' })).toBe(true);
    });

    it('accepts the prompt-route task-append shape', () => {
      // register-routes.ts: /sessions/:id/prompt appends task_id to session.tasks
      expect(isPromptFlowPatchOnly({ tasks: ['task-1', 'task-2'] })).toBe(true);
    });

    it('accepts the prompt-route auto-unarchive shape', () => {
      // register-routes.ts: /sessions/:id/prompt auto-unarchives before sending
      expect(isPromptFlowPatchOnly({ archived: false, archived_reason: undefined })).toBe(true);
    });

    it('accepts the stop-route idle shape', () => {
      // register-routes.ts: /sessions/:id/stop sets status + ready_for_prompt
      // (ready_for_prompt: true so the post-patch hook drains any QUEUED tasks)
      expect(isPromptFlowPatchOnly({ status: 'idle', ready_for_prompt: true })).toBe(true);
    });

    it('accepts the executor git-SHA capture shape', () => {
      // packages/executor/src/handlers/sdk/base-executor.ts patches current SHA
      expect(isPromptFlowPatchOnly({ git_state: { current_sha: 'deadbeef', ref: 'main' } })).toBe(
        true
      );
    });

    it('accepts the executor opencode init shape', () => {
      // packages/executor/src/handlers/sdk/opencode.ts patches the SDK session handle
      expect(isPromptFlowPatchOnly({ sdk_session_id: 'opencode-sess-123' })).toBe(true);
    });
  });

  describe('rejects mixed or metadata patches', () => {
    it('rejects a patch that mixes whitelist + metadata field', () => {
      // Prevents partial-trust escalation: if `tasks` is allowed at session-tier,
      // a caller must NOT be able to piggyback `name` (metadata) onto the same patch.
      expect(isPromptFlowPatchOnly({ tasks: ['t'], name: 'evil' })).toBe(false);
    });

    it.each([
      ['name', 'metadata'],
      ['model_config', { model: 'x' }],
      ['permission_config', { mode: 'bypass' }],
      ['callback_config', { callback_session_id: 'sid' }],
      ['created_by', 'other-user'],
      ['unix_username', 'root'],
      ['worktree_id', 'wt-evil'],
    ])('rejects pure-metadata patch on field: %s', (field, value) => {
      expect(isPromptFlowPatchOnly({ [field]: value })).toBe(false);
    });
  });

  describe('rejects non-object inputs', () => {
    it('rejects null', () => {
      expect(isPromptFlowPatchOnly(null)).toBe(false);
    });

    it('rejects undefined', () => {
      expect(isPromptFlowPatchOnly(undefined)).toBe(false);
    });

    it('rejects empty object (nothing to patch = cannot be a prompt-flow patch)', () => {
      expect(isPromptFlowPatchOnly({})).toBe(false);
    });

    it('rejects primitives', () => {
      expect(isPromptFlowPatchOnly('string')).toBe(false);
      expect(isPromptFlowPatchOnly(42)).toBe(false);
      expect(isPromptFlowPatchOnly(true)).toBe(false);
    });
  });
});

/**
 * Guards the fix for CVE-class issue: `after: get` on /sessions was minting
 * an MCP token (with `uid = session.created_by`) for any `member+` caller
 * with `view` permission on the worktree, letting them impersonate the
 * creator on the MCP channel. Only the creator, a superadmin, or the
 * executor's service identity may receive the token.
 */
describe('canReceiveMcpTokenForSession', () => {
  const CREATOR = 'user-creator';
  const OTHER = 'user-other';

  it('allows the session creator (matching user_id)', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: CREATOR,
        callerRole: 'member',
        sessionCreatedBy: CREATOR,
      })
    ).toBe(true);
  });

  it('allows a superadmin even if not the creator', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: OTHER,
        callerRole: 'superadmin',
        sessionCreatedBy: CREATOR,
      })
    ).toBe(true);
  });

  it('allows the executor service identity (role=service)', () => {
    // role 'service' is not in ROLE_RANK, so hasMinimumRole returns false for
    // it — the predicate must match it explicitly.
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: 'executor-service',
        callerRole: 'service',
        sessionCreatedBy: CREATOR,
      })
    ).toBe(true);
  });

  it('denies a member+ viewer who is NOT the creator (the bypass we fixed)', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: OTHER,
        callerRole: 'member',
        sessionCreatedBy: CREATOR,
      })
    ).toBe(false);
  });

  it('denies a plain admin who is NOT the creator (only superadmin gets through)', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: OTHER,
        callerRole: 'admin',
        sessionCreatedBy: CREATOR,
      })
    ).toBe(false);
  });

  it('denies a creator who has been demoted to viewer', () => {
    // Viewers never receive MCP tokens per docs — the creator match alone
    // isn't enough, they must also be at least a member.
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: CREATOR,
        callerRole: 'viewer',
        sessionCreatedBy: CREATOR,
      })
    ).toBe(false);
  });

  it('denies anonymous callers (no user_id, no role)', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: undefined,
        callerRole: undefined,
        sessionCreatedBy: CREATOR,
      })
    ).toBe(false);
  });

  it('denies when session has no created_by and caller is not privileged', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: OTHER,
        callerRole: 'member',
        sessionCreatedBy: null,
      })
    ).toBe(false);
  });

  it('does NOT match empty-string caller user_id against empty-string created_by', () => {
    // Empty-string coincidence must not count as "creator match" — this is
    // why the predicate guards with `!!callerUserId` before comparing.
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: '',
        callerRole: 'member',
        sessionCreatedBy: '',
      })
    ).toBe(false);
  });
});
