import type { Branch, Session } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  buildBranchCreatedAnalyticsProperties,
  buildSessionCreatedAnalyticsProperties,
} from './analytics-payloads.js';

describe('analytics payload builders', () => {
  it('keeps branch.created payloads curated and avoids branch names/refs', () => {
    const branch = {
      branch_id: 'branch-1',
      repo_id: 'repo-1',
      board_id: 'board-1',
      name: 'customer-secret-incident-title',
      ref: 'feature/customer-secret-incident-title',
      ref_type: 'branch',
      new_branch: true,
      custom_context: { teammate: { kind: 'teammate' } },
    } as unknown as Branch;

    const payload = buildBranchCreatedAnalyticsProperties(branch);

    expect(payload).toEqual({
      branch_id: 'branch-1',
      repo_id: 'repo-1',
      board_id: 'board-1',
      ref_type: 'branch',
      new_branch: true,
      is_teammate: true,
    });
    expect(payload).not.toHaveProperty('name');
    expect(payload).not.toHaveProperty('ref');
  });

  it('keeps session.created payloads curated and avoids metadata/full records', () => {
    const session = {
      session_id: 'session-1',
      branch_id: 'branch-1',
      created_by: 'user-1',
      name: 'sensitive session title',
      agentic_tool: 'codex',
      agentic_tool_version: '1.2.3',
      model_config: {
        mode: 'alias',
        model: 'gpt-test',
        provider: 'test-provider',
      },
      permission_config: { mode: 'allow-all' },
      genealogy: {
        parent_session_id: 'parent-1',
        forked_from_session_id: null,
      },
      metadata: { prompt: 'do not emit raw prompt metadata' },
      callback_config: { callback_session_id: 'callback-1' },
    } as unknown as Session;

    const payload = buildSessionCreatedAnalyticsProperties(session);

    expect(payload).toEqual({
      session_id: 'session-1',
      branch_id: 'branch-1',
      agentic_tool: 'codex',
      agentic_tool_version: '1.2.3',
      model: 'gpt-test',
      model_mode: 'alias',
      provider: 'test-provider',
      permission_mode: 'allow-all',
      has_parent_session: true,
      has_fork_source: false,
      fork_origin: null,
    });
    expect(payload).not.toHaveProperty('name');
    expect(payload).not.toHaveProperty('metadata');
    expect(payload).not.toHaveProperty('callback_config');
  });
});
