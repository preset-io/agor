import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every prompt an MCP tool submits is composed by the calling agent, never
 * typed by a human. Two fields carry that fact to the destination Session:
 *
 *   - `provider: undefined` — without it `normalizeMessageSource` forces
 *     `source: 'agor'`, and the prompt route rejects internal `metadata`
 *     outright (`Forbidden: Task metadata is internal-only`).
 *   - `metadata: { system_authored: true }` — what makes `resolvePromptOrigin`
 *     withhold `{ kind: 'human' }` from the SDK user message.
 *
 * Omitting them is silent: the prompt still delivers, just wearing human trust
 * authority it never earned. So this asserts over every call site and pins the
 * roster so a new tool cannot join without a decision.
 */
const TOOLS_DIR = __dirname;

/** Ordered call sites, as `<file>:<nth occurrence in that file>`. */
const EXPECTED_CALL_SITES = [
  'branches.ts#1',
  'sessions.ts#1',
  'sessions.ts#2',
  'sessions.ts#3',
  'sessions.ts#4',
  'sessions.ts#5',
  'widgets.ts#1',
];

const PROMPT_SERVICE = "service('/sessions/:id/prompt')";

/** Slice from a `service(...)` hit through the balanced `.create(...)` args. */
function sliceCreateCall(source: string, serviceIndex: number): string {
  const open = source.indexOf('(', source.indexOf('.create', serviceIndex));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) return source.slice(serviceIndex, i + 1);
    }
  }
  throw new Error(`Unbalanced .create( call at offset ${serviceIndex}`);
}

function collectCallSites(): { id: string; call: string }[] {
  const sites: { id: string; call: string }[] = [];
  for (const file of readdirSync(TOOLS_DIR).sort()) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const source = readFileSync(join(TOOLS_DIR, file), 'utf8');
    let index = source.indexOf(PROMPT_SERVICE);
    let nth = 0;
    while (index !== -1) {
      sites.push({ id: `${file}#${++nth}`, call: sliceCreateCall(source, index) });
      index = source.indexOf(PROMPT_SERVICE, index + PROMPT_SERVICE.length);
    }
  }
  return sites;
}

describe('MCP tool prompt provenance', () => {
  const callSites = collectCallSites();

  it('knows about every MCP tool that submits a prompt', () => {
    expect(callSites.map((site) => site.id)).toEqual(EXPECTED_CALL_SITES);
  });

  it.each(callSites)('$id drops the provider so internal metadata is accepted', ({ call }) => {
    expect(call).toContain('provider: undefined');
  });

  it.each(callSites)('$id marks the prompt system-authored, not human', ({ call }) => {
    expect(call).toMatch(/metadata: \{[^}]*system_authored: true/);
  });

  /**
   * The server-stamped provenance envelope rides on `ctx.baseServiceParams`
   * rather than being requested per call site, so that a tool cannot deliver
   * agent text unattributed by forgetting to opt in. That only holds while
   * every call site passes those params through - directly, or through a
   * helper that carries the stamp forward. A call site that assembles its own
   * params object would silently reopen the gap.
   */
  it.each(callSites)('$id passes the request params through, keeping the stamp', ({ call }) => {
    expect(call).toMatch(
      /\.\.\.(ctx\.baseServiceParams|callbackParams|withPromptProvenanceTool\(|freshMcpServiceParams\()/
    );
  });
});
