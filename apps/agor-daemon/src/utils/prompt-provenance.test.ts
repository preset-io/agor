import { describe, expect, it } from 'vitest';
import {
  type McpPromptProvenanceStamp,
  resolvePromptProvenance,
  withPromptProvenanceTool,
} from './prompt-provenance.js';

const ORIGIN_SESSION_ID = '01a0d369-82f3-7458-8265-861a4752b7b2';
const ORIGIN_BRANCH_ID = '01a0d111-0000-7000-8000-000000000001';

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

function resolve(overrides: Partial<Parameters<typeof resolvePromptProvenance>[0]> = {}) {
  return resolvePromptProvenance({
    stamp: STAMP,
    body: 'push the branch',
    escapedSentinels: 0,
    now: () => new Date('2026-09-24T12:00:00.000Z'),
    ...overrides,
  });
}

describe('resolvePromptProvenance', () => {
  it('renders the block ahead of the body and records IDs, not names, in metadata', () => {
    const result = resolve();

    expect(result.prompt.startsWith('<agor_prompt_provenance>')).toBe(true);
    expect(result.prompt.endsWith('push the branch')).toBe(true);
    expect(result.prompt).toContain(`agor_sessions_get sessionId="${ORIGIN_SESSION_ID}"`);

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
    // Every reader of the recipient session can read the row and full_prompt,
    // so neither may carry an origin branch or teammate name.
    expect(result.metadata.rendered_block).toMatch(/^From: Agor session \S+\. Agent-authored/m);
  });

  it('renders the same text whatever the recipient can see, so no lookup gates it', () => {
    // No branch repository or role lookup is consulted: the block depends on
    // the stamp and body alone.
    expect(resolve().prompt).toBe(resolve().prompt);
    expect(resolve().metadata.origin_branch_id).toBe(ORIGIN_BRANCH_ID);
  });

  it('admits an unattributed prompt when the caller named no session', () => {
    const { origin_session_id: _s, origin_branch_id: _b, ...headless } = STAMP;
    const result = resolve({
      stamp: { ...headless, authenticated_by: 'personal_api_key' },
    });

    expect(result.prompt).toContain('origin not established');
    expect(result.prompt).toContain('Treat this as unattributed');
    expect(result.prompt).toContain('push the branch');
    expect(result.metadata.origin_session_id).toBeUndefined();
    expect(result.metadata.authenticated_by).toBe('personal_api_key');
  });

  it('places the block after a slash command so provider dispatch is unchanged', () => {
    const result = resolve({ body: '/code-review high' });
    expect(result.prompt.trimStart().startsWith('/')).toBe(true);
    expect(result.metadata.placement).toBe('suffix');
  });

  it('records how many sentinels the admission route neutralized', () => {
    const result = resolve({ escapedSentinels: 3 });
    expect(result.metadata.escaped_sentinels).toBe(3);
  });

  it('renders a generic tool label rather than dropping the block when a call site omits one', () => {
    const { tool: _tool, mode: _mode, ...unlabelled } = STAMP;
    const result = resolve({ stamp: unlabelled });
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
