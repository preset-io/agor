import { describe, expect, it } from 'vitest';
import { buildZoneTriggerTemplateContext } from './worktrees.js';

describe('buildZoneTriggerTemplateContext', () => {
  it('includes session context for existing-session zone triggers', () => {
    const context = buildZoneTriggerTemplateContext({
      worktree: {
        name: 'demo-task',
        ref: 'feature/demo-task',
        issue_url: 'https://example.com/issues/1',
        pull_request_url: 'https://example.com/pulls/2',
        notes: 'Worktree notes',
        custom_context: { priority: 'high' },
      },
      board: {
        name: 'Compozy Delivery',
        description: 'Board description',
        custom_context: { team: 'delivery' },
      },
      session: {
        description: 'Existing task session',
        custom_context: { autoSelectRecommendations: true },
      },
      zone: {
        label: 'PRD',
        status: 'active',
      },
    });

    expect(context).toEqual({
      worktree: {
        name: 'demo-task',
        ref: 'feature/demo-task',
        issue_url: 'https://example.com/issues/1',
        pull_request_url: 'https://example.com/pulls/2',
        notes: 'Worktree notes',
        context: { priority: 'high' },
        custom_context: { priority: 'high' },
      },
      board: {
        name: 'Compozy Delivery',
        description: 'Board description',
        context: { team: 'delivery' },
        custom_context: { team: 'delivery' },
      },
      session: {
        description: 'Existing task session',
        context: { autoSelectRecommendations: true },
        custom_context: { autoSelectRecommendations: true },
      },
      zone: {
        label: 'PRD',
        status: 'active',
      },
    });
  });

  it('falls back to empty session context when no target session exists', () => {
    const context = buildZoneTriggerTemplateContext({
      worktree: {
        name: 'demo-task',
        ref: 'feature/demo-task',
        issue_url: undefined,
        pull_request_url: undefined,
        notes: undefined,
        custom_context: undefined,
      },
      board: {
        name: 'Compozy Delivery',
        description: undefined,
        custom_context: undefined,
      },
      zone: {
        label: 'Idea',
        status: undefined,
      },
    });

    expect(context).toEqual({
      worktree: {
        name: 'demo-task',
        ref: 'feature/demo-task',
        issue_url: '',
        pull_request_url: '',
        notes: '',
        context: {},
        custom_context: {},
      },
      board: {
        name: 'Compozy Delivery',
        description: '',
        context: {},
        custom_context: {},
      },
      session: {
        description: '',
        context: {},
        custom_context: {},
      },
      zone: {
        label: 'Idea',
        status: '',
      },
    });
  });
});
