import type { MCPServer } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { createMcpToolPermissionHook } from './mcp-tool-permission-hook.js';
import {
  buildMcpToolPermissionIndex,
  EMPTY_MCP_TOOL_PERMISSION_INDEX,
} from './mcp-tool-permissions.js';

const index = buildMcpToolPermissionIndex([
  {
    name: 'github',
    tool_permissions: {
      create_pull_request: 'deny',
      merge_pull_request: 'ask',
      list_issues: 'allow',
    },
  } as unknown as MCPServer,
]);

function invoke(hook: ReturnType<typeof createMcpToolPermissionHook>, toolName: string) {
  return hook(
    {
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: {},
      tool_use_id: 'tool-1',
    } as never,
    'tool-1',
    { signal: new AbortController().signal }
  );
}

describe('createMcpToolPermissionHook', () => {
  it('denies a denied tool ahead of settings.json rule matching', async () => {
    const hook = createMcpToolPermissionHook(index, true);

    const result = await invoke(hook, 'mcp__github__create_pull_request');

    expect(result.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
    });
  });

  it('forces an "ask" tool to prompt even when a persisted allow rule exists', async () => {
    // The SDK consults settings.json BEFORE canUseTool, so without this decision
    // a stale "remember for project" allow would skip the gate entirely.
    const hook = createMcpToolPermissionHook(index, true);

    const result = await invoke(hook, 'mcp__github__merge_pull_request');

    expect(result.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
    });
  });

  it('fails an "ask" tool closed when there is no approval channel', async () => {
    const hook = createMcpToolPermissionHook(index, false);

    const result = await invoke(hook, 'mcp__github__merge_pull_request');

    expect(result.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
  });

  it('lets allowed, unlisted and non-MCP tools proceed untouched', async () => {
    const hook = createMcpToolPermissionHook(index, true);

    for (const toolName of ['mcp__github__list_issues', 'mcp__github__list_commits', 'Bash']) {
      const result = await invoke(hook, toolName);
      expect(result, toolName).toEqual({ continue: true });
    }
  });

  it('proceeds when nothing is configured at all', async () => {
    const hook = createMcpToolPermissionHook(EMPTY_MCP_TOOL_PERMISSION_INDEX, true);

    expect(await invoke(hook, 'mcp__github__create_pull_request')).toEqual({ continue: true });
  });
});
