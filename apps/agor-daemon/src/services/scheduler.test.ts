import type { Branch } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { renderSchedulePrompt } from './scheduler';

function makeBranch(overrides: Partial<Branch> = {}): Branch {
  return {
    branch_id: 'b' as Branch['branch_id'],
    repo_id: 'r',
    name: 'feat-auth',
    ref: 'feat-auth',
    new_branch: true,
    needs_attention: false,
    schedule_enabled: false,
    archived: false,
    last_used: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: 'u',
    path: '/tmp/feat-auth',
    issue_url: 'https://github.com/org/repo/issues/42',
    pull_request_url: 'https://github.com/org/repo/pull/7',
    notes: 'wip notes',
    custom_context: { team: 'platform' },
    ...overrides,
  } as Branch;
}

describe('renderSchedulePrompt', () => {
  it('renders {{branch.*}} fields (canonical names)', () => {
    const out = renderSchedulePrompt(
      'Working on {{branch.name}} ({{branch.ref}}) — issue: {{branch.issue_url}}',
      makeBranch()
    );
    expect(out).toBe(
      'Working on feat-auth (feat-auth) — issue: https://github.com/org/repo/issues/42'
    );
  });

  it('renders {{worktree.*}} as a v0.19 backwards-compat alias of {{branch.*}}', () => {
    // Pre-rename schedule prompts authored against the v0.19 names must
    // keep working. The alias contract is shared with the env-template
    // context in handlebars-helpers.ts and the zone-trigger context in
    // zone-trigger-context.ts — bug-for-bug consistency across all three.
    const branch = makeBranch();
    const branchPrompt = renderSchedulePrompt(
      'b:{{branch.name}}|{{branch.ref}}|{{branch.issue_url}}|{{branch.notes}}|{{branch.custom_context.team}}',
      branch
    );
    const worktreePrompt = renderSchedulePrompt(
      'b:{{worktree.name}}|{{worktree.ref}}|{{worktree.issue_url}}|{{worktree.notes}}|{{worktree.custom_context.team}}',
      branch
    );
    expect(worktreePrompt).toBe(branchPrompt);
    expect(worktreePrompt).toBe(
      'b:feat-auth|feat-auth|https://github.com/org/repo/issues/42|wip notes|platform'
    );
  });

  it('falls back to the raw template when rendering throws', () => {
    // A Handlebars syntax error must not crash the scheduler tick — the
    // raw template gets handed to the agent so the user can see the bug
    // in their prompt instead of a silent skipped run.
    const out = renderSchedulePrompt('{{#if}} broken', makeBranch());
    expect(out).toBe('{{#if}} broken');
  });
});
