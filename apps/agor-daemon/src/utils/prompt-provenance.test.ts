import type { BranchRepository } from '@agor/core/db';
import type { Session } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  type McpPromptProvenanceStamp,
  resolvePromptProvenance,
  withPromptProvenanceTool,
} from './prompt-provenance.js';

const ORIGIN_SESSION_ID = '01a0d369-82f3-7458-8265-861a4752b7b2';
const ORIGIN_BRANCH_ID = '01a0d111-0000-7000-8000-000000000001';
const RECIPIENT_OWNER = '019f1bc1-bb61-7ea4-b9e1-0ecc173cccfb';

const STAMP: McpPromptProvenanceStamp = {
  authenticated_by: 'session_token',
  origin_user_id:
    '019f1bc1-bb61-7ea4-b9e1-0ecc173cccfb' as McpPromptProvenanceStamp['origin_user_id'],
  origin_user_label: 'amin@example.com',
  origin_session_id: ORIGIN_SESSION_ID as McpPromptProvenanceStamp['origin_session_id'],
  origin_branch_id: ORIGIN_BRANCH_ID as McpPromptProvenanceStamp['origin_branch_id'],
  origin_agentic_tool: 'claude-code',
  tool: 'agor_sessions_prompt',
  mode: 'continue',
};

function branchRepo(permission: string): BranchRepository {
  return {
    findById: vi.fn(async () => ({
      branch_id: ORIGIN_BRANCH_ID,
      name: 'elena',
      custom_context: { teammate: { kind: 'teammate', displayName: 'Elena' } },
    })) as unknown as BranchRepository['findById'],
    resolveUserPermission: vi.fn(async () => permission),
  } as unknown as BranchRepository;
}

const RECIPIENT = { created_by: RECIPIENT_OWNER } as unknown as Pick<Session, 'created_by'>;

function resolve(overrides: Partial<Parameters<typeof resolvePromptProvenance>[0]> = {}) {
  return resolvePromptProvenance({
    stamp: STAMP,
    body: 'push the branch',
    escapedSentinels: 0,
    recipientSession: RECIPIENT,
    branchRepo: branchRepo('all'),
    findUserRole: async () => 'member',
    now: () => new Date('2026-09-24T12:00:00.000Z'),
    ...overrides,
  });
}

describe('resolvePromptProvenance', () => {
  it('renders the block ahead of the body and records IDs, not names, in metadata', async () => {
    const result = await resolve();

    expect(result.prompt.startsWith('<agor_prompt_provenance>')).toBe(true);
    expect(result.prompt.endsWith('push the branch')).toBe(true);
    expect(result.prompt).toContain('teammate Elena (branch elena)');

    expect(result.metadata).toMatchObject({
      version: 1,
      authenticated_by: 'session_token',
      origin_session_id: ORIGIN_SESSION_ID,
      origin_branch_id: ORIGIN_BRANCH_ID,
      origin_agentic_tool: 'claude-code',
      tool: 'agor_sessions_prompt',
      mode: 'continue',
      placement: 'prefix',
      stamped_at: '2026-09-24T12:00:00.000Z',
    });
    // Display names are gated per recipient at render time, so the durable row
    // must not carry them - it would become a side channel around that gate.
    expect(JSON.stringify({ ...result.metadata, rendered_block: '' })).not.toContain('elena');
  });

  it('withholds branch and teammate when the recipient owner cannot read the origin branch', async () => {
    const result = await resolve({
      branchRepo: branchRepo('none'),
      findUserRole: async () => 'member',
    });

    expect(result.prompt).toContain('01a0d369');
    expect(result.prompt).toContain('withheld');
    expect(result.prompt).not.toContain('Elena');
    // The identity the recipient can act on is still durable.
    expect(result.metadata.origin_branch_id).toBe(ORIGIN_BRANCH_ID);
  });

  it('shows the names to a superadmin recipient owner, who could read the branch anyway', async () => {
    const result = await resolve({
      branchRepo: branchRepo('none'),
      findUserRole: async () => 'superadmin',
    });
    expect(result.prompt).toContain('teammate Elena (branch elena)');
  });

  it('admits an unattributed prompt when the caller named no session', async () => {
    const { origin_session_id: _s, origin_branch_id: _b, ...headless } = STAMP;
    const result = await resolve({
      stamp: { ...headless, authenticated_by: 'personal_api_key' },
    });

    expect(result.prompt).toContain('origin not established');
    expect(result.prompt).toContain('Treat this as unattributed');
    expect(result.prompt).toContain('push the branch');
    expect(result.metadata.origin_session_id).toBeUndefined();
    expect(result.metadata.authenticated_by).toBe('personal_api_key');
  });

  it('places the block after a slash command so provider dispatch is unchanged', async () => {
    const result = await resolve({ body: '/code-review high' });
    expect(result.prompt.trimStart().startsWith('/')).toBe(true);
    expect(result.metadata.placement).toBe('suffix');
  });

  it('records how many sentinels the admission route neutralized', async () => {
    const result = await resolve({ escapedSentinels: 3 });
    expect(result.metadata.escaped_sentinels).toBe(3);
  });

  it('renders a generic tool label rather than dropping the block when a call site omits one', async () => {
    const { tool: _tool, mode: _mode, ...unlabelled } = STAMP;
    const result = await resolve({ stamp: unlabelled });
    expect(result.prompt).toContain('<agor_prompt_provenance>');
    expect(result.metadata.tool).toBe('mcp');
  });
});

describe('withPromptProvenanceTool', () => {
  it('names the tool without disturbing the server-derived identity fields', () => {
    const { mode: _mode, ...unlabelled } = STAMP;
    const params = {
      _promptProvenance: { ...unlabelled, tool: 'agor_sessions_create' },
      provider: 'mcp',
    };
    const labelled = withPromptProvenanceTool(params, 'agor_sessions_prompt', 'fork');

    expect(labelled._promptProvenance).toMatchObject({
      authenticated_by: 'session_token',
      origin_session_id: ORIGIN_SESSION_ID,
      tool: 'agor_sessions_prompt',
      mode: 'fork',
    });
    expect(params._promptProvenance.tool).toBe('agor_sessions_create');
    expect(params._promptProvenance).not.toHaveProperty('mode');
  });

  it('is a no-op when the request carries no stamp at all', () => {
    const params = { provider: 'mcp' } as { _promptProvenance?: McpPromptProvenanceStamp };
    expect(withPromptProvenanceTool(params, 'agor_sessions_prompt')).toBe(params);
  });
});
