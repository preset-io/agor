import { describe, expect, it } from 'vitest';
import { buildZoneTriggerContext } from './zone-trigger-context';

describe('buildZoneTriggerContext', () => {
  it('maps worktree.custom_context to worktree.context (canonical name)', () => {
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
    });
    // The `custom_context` key must NOT leak into the rendered context shape
    // — it's the data field, not the template-facing alias.
    expect((ctx.worktree as Record<string, unknown>).custom_context).toBeUndefined();
  });

  it('maps board.custom_context to board.context', () => {
    const ctx = buildZoneTriggerContext({
      board: { name: 'b', description: 'd', custom_context: { team: 'platform' } },
    });
    expect(ctx.board).toEqual({ name: 'b', description: 'd', context: { team: 'platform' } });
  });

  it('maps session.custom_context to session.context', () => {
    const ctx = buildZoneTriggerContext({
      session: { description: 'foo', custom_context: { kind: 'review' } },
    });
    expect(ctx.session).toEqual({ description: 'foo', context: { kind: 'review' } });
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
    });
    expect(ctx.board).toEqual({ name: '', description: '', context: {} });
    expect(ctx.zone).toEqual({ label: '', status: '' });
    expect(ctx.session).toEqual({ description: '', context: {} });
  });
});
