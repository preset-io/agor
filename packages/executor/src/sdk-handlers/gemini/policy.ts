import { lstatSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import type * as SDK from '@google/gemini-cli-core';

/** Accept edits is closed; Bypass deliberately inherits the SDK's YOLO built-ins. */
export function buildGeminiPolicy(
  sdk: typeof SDK,
  approvalMode: SDK.ApprovalMode,
  servers: Record<string, SDK.MCPServerConfig>
): SDK.PolicyEngineConfig {
  const { PolicyDecision: D, ApprovalMode: M } = sdk;
  const rules: SDK.PolicyRule[] = [];
  const source = 'Agor permission policy';
  for (const [name, server] of Object.entries(servers)) {
    for (const tool of server.excludeTools ?? []) {
      rules.push({
        toolName: sdk.generateValidName(`${name}_${tool}`),
        mcpName: name,
        decision: D.DENY,
        priority: 100,
        source,
      });
    }
    rules.push({ toolName: '*', mcpName: name, decision: D.ALLOW, priority: 60, source });
  }
  for (const toolName of [
    'ask_user',
    'enter_plan_mode',
    'exit_plan_mode',
    'tracker_create_task',
    'tracker_update_task',
    'tracker_get_task',
    'tracker_list_tasks',
    'tracker_add_dependency',
    'tracker_visualize',
  ]) {
    rules.push({ toolName, decision: D.DENY, priority: 100, source });
  }
  rules.push({ toolName: '*', mcpName: '*', decision: D.DENY, priority: 40, source });
  for (const toolName of [
    'read_file',
    'read_many_files',
    'list_directory',
    'glob',
    'grep_search',
    'read_mcp_resource',
    'list_mcp_resources',
    'write_file',
    'replace',
    'write_todos',
    'update_topic',
  ]) {
    rules.push({ toolName, decision: D.ALLOW, priority: 30, modes: [M.AUTO_EDIT], source });
  }
  for (const toolName of [
    'run_shell_command',
    'list_background_processes',
    'read_background_output',
    'web_fetch',
    'google_web_search',
  ]) {
    // Keep these declarations visible so a request gets an actionable denial.
    rules.push({
      toolName,
      decision: D.DENY,
      priority: 90,
      modes: [M.AUTO_EDIT],
      argsPattern: /[\s\S]*/,
      denyMessage:
        'This tool needs Bypass. Switch to Bypass permissions to use shell or web access.',
      source,
    });
    rules.push({ toolName, decision: D.ASK_USER, priority: 89, modes: [M.AUTO_EDIT], source });
  }
  return {
    approvalMode,
    nonInteractive: true,
    defaultDecision: approvalMode === M.YOLO ? D.ALLOW : D.DENY,
    rules,
    checkers: ['write_file', 'replace'].map((toolName) => ({
      toolName,
      priority: 30,
      modes: [M.AUTO_EDIT],
      source,
      checker: {
        type: 'in-process',
        name: sdk.InProcessCheckerType.ALLOWED_PATH,
        required_context: ['environment'],
      },
    })),
  };
}

/** Resolve existing ancestors without treating dangling symlinks as new directories. */
function realPathWithMissingLeaf(target: string): string {
  try {
    lstatSync(target);
    return realpathSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // lstat succeeds on dangling symlinks, whose realpath must remain a failure.
    try {
      if (lstatSync(target).isSymbolicLink()) throw new Error('Dangling symlink');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(realPathWithMissingLeaf(parent), path.basename(target));
  }
}

export function installGeminiPolicy(sdk: typeof SDK, config: SDK.Config): void {
  const engine = config.getPolicyEngine();
  const servers = config.getMcpServers() ?? {};
  for (const agent of config.getAgentRegistry().getAllDefinitions()) {
    const declared = Object.keys(('mcpServers' in agent ? agent.mcpServers : undefined) ?? {});
    const clashes = declared.filter((name) => Object.hasOwn(servers, name));
    if (clashes.length) {
      engine.addRule({
        toolName: agent.name,
        decision: sdk.PolicyDecision.DENY,
        priority: 100,
        source: 'Agor MCP name clash',
        denyMessage: `Agent MCP server name clashes with Agor configuration: ${clashes.join(', ')}.`,
      });
    } else {
      for (const name of declared) {
        engine.addRule({
          toolName: '*',
          mcpName: name,
          subagent: agent.name,
          modes: [sdk.ApprovalMode.YOLO],
          decision: sdk.PolicyDecision.ALLOW,
          priority: 55,
          source: 'Agor agent-declared MCP',
        });
      }
    }
  }
  const check = engine.check.bind(engine);
  const workspace = realpathSync(config.getTargetDir());
  engine.check = async (call, server, annotations, subagent, skip) => {
    if (call.name?.startsWith('tracker_')) return { decision: sdk.PolicyDecision.DENY };
    const result = await check(call, server, annotations, subagent, skip);
    if (
      result.decision !== sdk.PolicyDecision.DENY ||
      result.rule?.source !== 'Build File Protection' ||
      server ||
      annotations?._serverName ||
      subagent ||
      !['write_file', 'replace'].includes(call.name ?? '') ||
      ![sdk.ApprovalMode.AUTO_EDIT, sdk.ApprovalMode.YOLO].includes(engine.getApprovalMode()) ||
      !call.args ||
      'additional_permissions' in call.args ||
      typeof call.args.file_path !== 'string'
    )
      return result;
    try {
      const target = sdk.resolveDefensiveToolPath(call.args.file_path, config.getTargetDir());
      const real = realPathWithMissingLeaf(path.resolve(config.getTargetDir(), target));
      if (real !== workspace && !real.startsWith(workspace + path.sep)) return result;
    } catch {
      return result;
    }
    return {
      decision: sdk.PolicyDecision.ALLOW,
      rule: {
        toolName: call.name!,
        decision: sdk.PolicyDecision.ALLOW,
        priority: Number.MAX_SAFE_INTEGER,
        source: 'Agor build-file approval',
      },
    };
  };
}
