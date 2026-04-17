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
import { isPromptFlowPatchOnly, PROMPT_FLOW_PATCH_FIELDS } from './register-hooks';

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
      expect(isPromptFlowPatchOnly({ status: 'idle', ready_for_prompt: false })).toBe(true);
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
