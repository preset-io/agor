import { describe, expect, it } from 'vitest';
import { buildZoneTriggerContext } from './zone-trigger-context';

describe('buildZoneTriggerContext', () => {
  it('exposes worktree custom_context as both `context` and `custom_context` (BC alias)', () => {
    const ctx = buildZoneTriggerContext({
      worktree: {
        name: 'wt',
        ref: 'main',
        custom_context: { issue: 'PROJ-42' },
      },
    });
    expect(ctx.worktree).toMatchObject({
      name: 'wt',
      ref: 'main',
      context: { issue: 'PROJ-42' },
      custom_context: { issue: 'PROJ-42' },
    });
    // Both keys reference the same object (templates can use either path).
    const w = ctx.worktree as Record<string, unknown>;
    expect(w.context).toBe(w.custom_context);
  });

  it('exposes board custom_context as both `context` and `custom_context`', () => {
    const ctx = buildZoneTriggerContext({
      board: { name: 'b', description: 'd', custom_context: { team: 'platform' } },
    });
    expect(ctx.board).toEqual({
      name: 'b',
      description: 'd',
      context: { team: 'platform' },
      custom_context: { team: 'platform' },
    });
  });

  it('exposes session custom_context as both `context` and `custom_context`', () => {
    const ctx = buildZoneTriggerContext({
      session: { description: 'foo', custom_context: { kind: 'review' } },
    });
    expect(ctx.session).toEqual({
      description: 'foo',
      context: { kind: 'review' },
      custom_context: { kind: 'review' },
    });
  });

  it('exposes zone.label and zone.status', () => {
    const ctx = buildZoneTriggerContext({
      zone: { label: 'In Review', status: 'active' },
    });
    expect(ctx.zone).toEqual({ label: 'In Review', status: 'active' });
  });

  it('defaults all fields to safe empties when inputs are absent', () => {
    const ctx = buildZoneTriggerContext({});
    expect(ctx.worktree).toEqual({
      name: '',
      ref: '',
      issue_url: '',
      pull_request_url: '',
      notes: '',
      path: '',
      context: {},
      custom_context: {},
    });
    expect(ctx.board).toEqual({ name: '', description: '', context: {}, custom_context: {} });
    expect(ctx.zone).toEqual({ label: '', status: '' });
    expect(ctx.session).toEqual({ description: '', context: {}, custom_context: {} });
  });
});
