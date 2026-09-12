import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type * as ClaudeSdk from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ReplicatedWorkspaceDescriptor } from './payload-types.js';

const active = new AsyncLocalStorage<ReplicatedWorkspaceDescriptor>();
const unverified = new WeakSet<ReplicatedWorkspaceDescriptor>();
export function markUnverifiedSdkTeardown(): void {
  const value = active.getStore();
  if (value) unverified.add(value);
}
export const currentReplicatedWorkspace = () => active.getStore();
export async function withReplicatedWorkspace<T>(
  workspace: ReplicatedWorkspaceDescriptor | undefined,
  tool: string,
  work: () => Promise<T>
): Promise<T> {
  if (!workspace) return work();
  if (tool !== 'claude-code')
    throw new Error(
      'Replicated workspaces currently require Claude Code; legacy execution is refused.'
    );
  return active.run(workspace, work);
}

/** Model tools execute in a worker-owned container, never in the SDK's read-only code mount. */
export function configureReplicatedClaude(
  sdk: Pick<typeof ClaudeSdk, 'createSdkMcpServer' | 'tool'>,
  options: Record<string, unknown>,
  workspace: ReplicatedWorkspaceDescriptor,
  request: typeof fetch = fetch
): void {
  // An explicit empty native tool set prevents Bash, subagents and project hooks
  // from writing around the publication boundary. Do not silently fall back.
  options.cwd = workspace.cwd;
  options.tools = [];
  options.settingSources = [];
  options.additionalDirectories = [];
  options.allowedTools = ['mcp__agor_workspace__execute'];
  options.disallowedTools = [];
  options.hooks = {};
  options.canUseTool = async (name: string, input: unknown) =>
    name === 'mcp__agor_workspace__execute'
      ? { behavior: 'allow', updatedInput: input }
      : {
          behavior: 'deny',
          message: 'This tool cannot bypass the replicated workspace controller',
        };
  options.mcpServers = {
    agor_workspace: sdk.createSdkMcpServer({
      name: 'agor_workspace',
      tools: [
        sdk.tool(
          'execute',
          'Run a shell command in your isolated branch replica. Use this for ALL code reads, edits, searches, installs and tests. At start it refreshes committed changes; on completion your entire source mutation is atomically committed or returns an explicit conflict. Dependencies and build products stay local. Background processes do not survive this tool. Never automatically retry a command after an uncertain response.',
          {
            command: z.string().min(1).max(65536),
            timeout_ms: z.number().int().min(1000).max(120000).default(120000),
          },
          async ({ command, timeout_ms }) => {
            const idempotencyKey = randomUUID();
            // Never retry an uncertain response by running the shell again.
            const response = await request(`${workspace.endpoint}/execute`, {
              method: 'POST',
              headers: {
                authorization: `Bearer ${workspace.capability}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({ command, timeout_ms, idempotencyKey }),
              signal: AbortSignal.timeout(timeout_ms + 60000),
            });
            const result = await response.text();
            if (!response.ok)
              throw new Error(
                `Workspace tool failed (${response.status}): ${result.slice(0, 4096)}`
              );
            const parsed = JSON.parse(result) as { outcome: { status: string }; exitCode: number };
            return {
              isError: parsed.outcome.status !== 'committed' || parsed.exitCode !== 0,
              content: [{ type: 'text', text: result }],
            };
          }
        ),
      ],
    }),
  };
}

/** SDK process teardown must finish before the worker snapshots transcripts. */
export async function finalizeReplicatedSession(): Promise<void> {
  const workspace = active.getStore();
  if (!workspace) return;
  if (unverified.has(workspace))
    throw new Error('SDK teardown unverified; task completion refused');
  const response = await fetch(`${workspace.endpoint}/finalize`, {
    method: 'POST',
    headers: { authorization: `Bearer ${workspace.capability}` },
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error('SDK state was not durably published; task completion refused');
}
