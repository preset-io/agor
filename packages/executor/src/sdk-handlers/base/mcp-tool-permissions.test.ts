import type { MCPServer, ToolPermission } from '@agor/core/types';
import { describe, expect, it } from 'vitest';

import {
  buildMcpToolPermissionIndex,
  EMPTY_MCP_TOOL_PERMISSION_INDEX,
  mcpToolNameAliasesForServer,
  resolveMcpToolPermission,
} from './mcp-tool-permissions.js';

function server(name: string, toolPermissions?: Record<string, ToolPermission>): MCPServer {
  return { name, tool_permissions: toolPermissions } as MCPServer;
}

describe('resolveMcpToolPermission', () => {
  const index = buildMcpToolPermissionIndex([
    server('github', { create_pull_request: 'deny', merge_pull_request: 'ask' }),
    server('linear', { create_issue: 'allow' }),
  ]);

  it('maps a Claude-namespaced tool name onto the bare key it is stored under', () => {
    // tool_permissions is keyed on `create_pull_request`; the SDK asks about
    // `mcp__github__create_pull_request`. Bridging the two IS the feature.
    expect(resolveMcpToolPermission(index, 'mcp__github__create_pull_request')).toBe('deny');
    expect(resolveMcpToolPermission(index, 'mcp__github__merge_pull_request')).toBe('ask');
    expect(resolveMcpToolPermission(index, 'mcp__linear__create_issue')).toBe('allow');
  });

  it('maps a Gemini server-qualified tool name', () => {
    expect(resolveMcpToolPermission(index, 'github__create_pull_request')).toBe('deny');
  });

  it('returns undefined for tools with no configured entry', () => {
    expect(resolveMcpToolPermission(index, 'mcp__github__list_issues')).toBeUndefined();
    expect(resolveMcpToolPermission(index, 'mcp__unknown__create_pull_request')).toBeUndefined();
    expect(resolveMcpToolPermission(index, 'Bash')).toBeUndefined();
    expect(resolveMcpToolPermission(EMPTY_MCP_TOOL_PERMISSION_INDEX, 'mcp__github__x')).toBe(
      undefined
    );
  });

  it('keeps the underscores inside a tool name intact', () => {
    const withUnderscores = buildMcpToolPermissionIndex([
      server('gh', { create__pull__request: 'deny' }),
    ]);

    expect(resolveMcpToolPermission(withUnderscores, 'mcp__gh__create__pull__request')).toBe(
      'deny'
    );
  });

  it('prefers the longest matching server prefix', () => {
    const overlapping = buildMcpToolPermissionIndex([
      server('gh', { enterprise__deploy: 'allow' }),
      server('gh__enterprise', { deploy: 'deny' }),
    ]);

    expect(resolveMcpToolPermission(overlapping, 'mcp__gh__enterprise__deploy')).toBe('deny');
  });

  it('matches servers whose names the SDK had to sanitize', () => {
    const spaced = buildMcpToolPermissionIndex([server('preset sdx', { run_query: 'deny' })]);

    expect(resolveMcpToolPermission(spaced, 'mcp__preset_sdx__run_query')).toBe('deny');
    expect(resolveMcpToolPermission(spaced, 'mcp__preset sdx__run_query')).toBe('deny');
  });

  // A dot is legal in an MCP server name but not in a tool name, so the SDK
  // must rewrite it. Missing the rewritten form would read as "unconfigured".
  it('matches servers whose names contain characters illegal in a tool name', () => {
    const dotted = buildMcpToolPermissionIndex([server('My.Server', { run_query: 'deny' })]);

    expect(resolveMcpToolPermission(dotted, 'mcp__My_Server__run_query')).toBe('deny');
    // Codex lowercases as well as sanitizing.
    expect(resolveMcpToolPermission(dotted, 'my_server__run_query')).toBe('deny');
  });

  // The CLI rewrites BOTH halves of a namespaced name, so a tool advertised as
  // `repo.create` is offered to the model as `mcp__gh__repo_create`. Keyed only
  // on the raw form, the lookup misses — and a miss reads as "unconfigured",
  // i.e. allow. The gate would be silently open on exactly the tool someone
  // switched off.
  it('matches tools whose names contain characters illegal in a tool name', () => {
    const dotted = buildMcpToolPermissionIndex([
      server('gh', { 'repo.create': 'deny', 'repo.read': 'allow' }),
    ]);

    expect(resolveMcpToolPermission(dotted, 'mcp__gh__repo_create')).toBe('deny');
    // The raw form still resolves, so nothing that worked before regressed.
    expect(resolveMcpToolPermission(dotted, 'mcp__gh__repo.create')).toBe('deny');
    // An unrelated permission is not dragged along by the rewrite.
    expect(resolveMcpToolPermission(dotted, 'mcp__gh__repo_read')).toBe('allow');
  });

  it('rewrites both halves at once', () => {
    const both = buildMcpToolPermissionIndex([server('My.Server', { 'repo.create': 'deny' })]);

    expect(resolveMcpToolPermission(both, 'mcp__My_Server__repo_create')).toBe('deny');
  });

  it('never matches a bare tool name, so an unrelated tool cannot be denied by coincidence', () => {
    expect(resolveMcpToolPermission(index, 'create_pull_request')).toBeUndefined();
    // Positive control: the same index does answer when the name is qualified,
    // so the miss above is the rule and not an empty fixture.
    expect(resolveMcpToolPermission(index, 'mcp__github__create_pull_request')).toBe('deny');
  });

  // "foo.bar" and "foo_bar" both rewrite to "foo_bar". Overwriting the shared
  // entry silently dropped the first server's denials, which the SDK would then
  // surface as unconfigured, i.e. allowed.
  it('merges servers whose names rewrite to the same alias instead of overwriting', () => {
    const colliding = buildMcpToolPermissionIndex([
      server('foo.bar', { write_file: 'deny' }),
      server('foo_bar', { read_file: 'allow' }),
    ]);

    expect(resolveMcpToolPermission(colliding, 'mcp__foo_bar__write_file')).toBe('deny');
    expect(resolveMcpToolPermission(colliding, 'mcp__foo_bar__read_file')).toBe('allow');
  });

  it('keeps the most restrictive value when colliding aliases disagree', () => {
    const colliding = buildMcpToolPermissionIndex([
      server('a.b', { search: 'allow' }),
      server('a_b', { search: 'deny' }),
    ]);

    expect(resolveMcpToolPermission(colliding, 'mcp__a_b__search')).toBe('deny');
  });

  it('is order-independent across colliding aliases', () => {
    const reversed = buildMcpToolPermissionIndex([
      server('a_b', { search: 'deny' }),
      server('a.b', { search: 'allow' }),
    ]);

    expect(resolveMcpToolPermission(reversed, 'mcp__a_b__search')).toBe('deny');
  });
});

/**
 * The Claude CLI sanitizes a server name the way we do, then applies an extra
 * squeeze -- collapse runs of `_`, trim them from both ends -- but ONLY when
 * the raw name begins `claude.ai `:
 *
 *     let t = e.replace(/[^a-zA-Z0-9_-]/g, "_");
 *     if (e.startsWith("claude.ai ")) t = t.replace(/_+/g, "_").replace(/^_|_$/g, "");
 *
 * Originally transcribed from the shipped 0.3.197 CLI and retained as a
 * compatibility contract across SDK upgrades. It matters because those are
 * exactly the names claude.ai connectors carry, and a name that misses reads
 * as unconfigured -- which is `allow`.
 */
describe('claude.ai connector names', () => {
  /** The CLI's own function, transcribed from the bundle. */
  const cliServerName = (raw: string) => {
    let t = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (raw.startsWith('claude.ai ')) t = t.replace(/_+/g, '_').replace(/^_|_$/g, '');
    return t;
  };

  it.each(['claude.ai Gmail (Beta)', 'claude.ai  Notion', 'claude.ai Drive.'])(
    'covers the name the CLI actually mints for %s',
    (raw) => {
      // Without the collapsed alias this misses, and the deny fails OPEN.
      expect(mcpToolNameAliasesForServer(raw)).toContain(cliServerName(raw));
    }
  );

  it('binds a deny to the tool name the CLI will present', () => {
    const raw = 'claude.ai Gmail (Beta)';
    const index = buildMcpToolPermissionIndex([
      server(raw, { delete_email: 'deny', list_email: 'allow' }),
    ]);

    expect(resolveMcpToolPermission(index, `mcp__${cliServerName(raw)}__delete_email`)).toBe(
      'deny'
    );
    // Positive control: the same server's allowed tool is not swept up.
    expect(resolveMcpToolPermission(index, `mcp__${cliServerName(raw)}__list_email`)).toBe('allow');
  });

  it('emits an alias free of doubled underscores, which the CLI would split on', () => {
    // The CLI resolves `mcp__a__b` by splitting on `__` and taking the FIRST
    // segment as the server, so an alias carrying `__` fragments and can never
    // be addressed at all.
    const aliases = mcpToolNameAliasesForServer('claude.ai Gmail (Beta)');
    expect(aliases.some((alias) => !alias.includes('__'))).toBe(true);
    expect(aliases).toContain('claude_ai_Gmail_Beta');
  });
});
