import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { type AgorConfig, ensureCodexHomeForUser } from '@agor/core/config';
import type { UserID } from '@agor/core/types';
import { buildSpawnArgs, escapeShellArg } from '@agor/core/unix';
import { type CodexAuthStatusContext, resolveCodexAuthStatusContext } from './codex-auth-status.js';

export type CodexDeviceAuthFlowStatus = 'pending' | 'completed' | 'failed' | 'cancelled';

export interface CodexDeviceAuthFlow {
  flowId: string;
  agorUserId: UserID;
  status: CodexDeviceAuthFlowStatus;
  verificationUri: string | null;
  userCode: string | null;
  codexHome: string;
  executionUnixUser: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ManagedCodexDeviceAuthFlow {
  snapshot: CodexDeviceAuthFlow;
  process: CodexDeviceAuthProcess | null;
  contextKey: string;
}

export interface CodexDeviceAuthProcess {
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface CodexDeviceAuthSpawnContext {
  agorUserId: UserID;
  codexHome: string;
  executionUnixUser: string | null;
}

export interface CodexDeviceAuthSpawnResult {
  process: CodexDeviceAuthProcess;
  context: CodexDeviceAuthSpawnContext;
}

export interface SpawnCodexDeviceAuthProcessOptions {
  agorUserId: UserID;
  sessionUnixUsername?: string | null;
}

export type SpawnCodexDeviceAuthProcess = (
  config: AgorConfig,
  options: SpawnCodexDeviceAuthProcessOptions,
  resolvedContext: CodexDeviceAuthSpawnContext
) => Promise<CodexDeviceAuthSpawnResult>;

interface CodexDeviceAuthManagerOptions {
  now?: () => number;
  flowTtlMs?: number;
  spawnProcess?: SpawnCodexDeviceAuthProcess;
}

type PendingContextStart = Promise<CodexDeviceAuthFlow>;

function stripAnsi(text: string): string {
  let result = '';

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (char === '\u001b' && text[i + 1] === '[') {
      i += 2;

      while (i < text.length && /[0-9;]/.test(text[i])) {
        i += 1;
      }

      continue;
    }

    result += char;
  }

  return result;
}

export function parseDeviceAuthOutput(output: string): {
  verificationUri: string | null;
  userCode: string | null;
} {
  const clean = stripAnsi(output);
  const verificationUriMatch = clean.match(/https?:\/\/[^\s]+/);
  const userCodeMatch = clean.match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/);

  return {
    verificationUri: verificationUriMatch?.[0] ?? null,
    userCode: userCodeMatch?.[0] ?? null,
  };
}

function getContextKey(
  context: Pick<CodexDeviceAuthFlow, 'agorUserId' | 'codexHome' | 'executionUnixUser'>
): string {
  return `${context.agorUserId}:${context.codexHome}:${context.executionUnixUser ?? 'current-user'}`;
}

function buildDeviceAuthCommand(codexHome: string): string {
  return `CODEX_HOME=${escapeShellArg(codexHome)} codex login --device-auth`;
}

export function buildDeviceAuthSpawnEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const nextEnv = { ...env };
  delete nextEnv.OPENAI_API_KEY;
  return nextEnv;
}

function toSpawnEnvRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

export function buildDeviceAuthSpawnOptions(
  context: Pick<CodexDeviceAuthSpawnContext, 'codexHome' | 'executionUnixUser'>,
  env: NodeJS.ProcessEnv = process.env
): {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const scrubbedEnv = buildDeviceAuthSpawnEnv(env);
  const { cmd, args } = buildSpawnArgs('sh', ['-lc', buildDeviceAuthCommand(context.codexHome)], {
    asUser: context.executionUnixUser ?? undefined,
    env: context.executionUnixUser ? toSpawnEnvRecord(scrubbedEnv) : undefined,
  });

  return {
    cmd,
    args,
    env: scrubbedEnv,
  };
}

export function resolveCodexDeviceAuthSpawnContext(
  config: AgorConfig,
  options: SpawnCodexDeviceAuthProcessOptions
): CodexDeviceAuthSpawnContext {
  const context: CodexAuthStatusContext = resolveCodexAuthStatusContext(config, options);

  return {
    agorUserId: context.agorUserId,
    codexHome: context.codexHome,
    executionUnixUser: context.executionUnixUser,
  };
}

export async function ensureCodexFileCredentialStore(codexHome: string): Promise<void> {
  const configPath = path.join(codexHome, 'config.toml');
  let configToml = '';

  try {
    configToml = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const fileStoreLine = 'cli_auth_credentials_store = "file"';
  const nextConfigToml = configToml.match(/^\s*cli_auth_credentials_store\s*=\s*"[^"]*"\s*$/m)
    ? configToml.replace(/^\s*cli_auth_credentials_store\s*=\s*"[^"]*"\s*$/m, fileStoreLine)
    : configToml.trim().length > 0
      ? `${configToml.replace(/\s*$/, '\n')}${fileStoreLine}\n`
      : `${fileStoreLine}\n`;

  await fs.writeFile(configPath, nextConfigToml, { mode: 0o600 });
}

export async function spawnCodexDeviceAuthProcess(
  config: AgorConfig,
  options: SpawnCodexDeviceAuthProcessOptions,
  resolvedContext: CodexDeviceAuthSpawnContext = resolveCodexDeviceAuthSpawnContext(config, options)
): Promise<CodexDeviceAuthSpawnResult> {
  const codexHome = await ensureCodexHomeForUser(options.agorUserId);
  await ensureCodexFileCredentialStore(codexHome);
  const context = {
    ...resolvedContext,
    codexHome,
  };
  const spawnOptions = buildDeviceAuthSpawnOptions(context);

  const child = spawn(spawnOptions.cmd, spawnOptions.args, {
    env: spawnOptions.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  }) as ChildProcess;

  return {
    process: child as CodexDeviceAuthProcess,
    context,
  };
}

export class CodexDeviceAuthManager {
  private flows = new Map<string, ManagedCodexDeviceAuthFlow>();
  private activeContextFlows = new Map<string, string>();
  private pendingContextStarts = new Map<string, PendingContextStart>();
  private readonly now: () => number;
  private readonly flowTtlMs: number;
  private readonly spawnProcess: SpawnCodexDeviceAuthProcess;

  constructor(options: CodexDeviceAuthManagerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.flowTtlMs = options.flowTtlMs ?? 15 * 60 * 1000;
    this.spawnProcess = options.spawnProcess ?? spawnCodexDeviceAuthProcess;
  }

  get(flowId: string): CodexDeviceAuthFlow | null {
    this.cleanupExpiredFlows();
    return this.flows.get(flowId)?.snapshot ?? null;
  }

  cancel(flowId: string): CodexDeviceAuthFlow | null {
    const existing = this.flows.get(flowId);
    if (!existing) {
      return null;
    }

    if (existing.snapshot.status === 'pending') {
      existing.process?.kill('SIGTERM');
      existing.process = null;
      this.updateFlow(existing, {
        status: 'cancelled',
        error: null,
      });
    }

    this.activeContextFlows.delete(existing.contextKey);
    return existing.snapshot;
  }

  async start(
    config: AgorConfig,
    options: SpawnCodexDeviceAuthProcessOptions
  ): Promise<CodexDeviceAuthFlow> {
    this.cleanupExpiredFlows();
    const context = resolveCodexDeviceAuthSpawnContext(config, options);
    const contextKey = getContextKey({
      agorUserId: options.agorUserId,
      codexHome: context.codexHome,
      executionUnixUser: context.executionUnixUser,
    });

    const activeFlowId = this.activeContextFlows.get(contextKey);
    if (activeFlowId) {
      const activeFlow = this.flows.get(activeFlowId);
      if (activeFlow?.snapshot.status === 'pending') {
        return activeFlow.snapshot;
      }
      this.activeContextFlows.delete(contextKey);
    }

    const pendingStart = this.pendingContextStarts.get(contextKey);
    if (pendingStart) {
      return await pendingStart;
    }

    const startPromise = this.startFlow(config, options, context, contextKey);
    this.pendingContextStarts.set(contextKey, startPromise);

    try {
      return await startPromise;
    } finally {
      if (this.pendingContextStarts.get(contextKey) === startPromise) {
        this.pendingContextStarts.delete(contextKey);
      }
    }
  }

  private updateFlow(
    flow: ManagedCodexDeviceAuthFlow,
    updates: Partial<Pick<CodexDeviceAuthFlow, 'status' | 'verificationUri' | 'userCode' | 'error'>>
  ): void {
    flow.snapshot = {
      ...flow.snapshot,
      ...updates,
      updatedAt: this.now(),
    };
    this.flows.set(flow.snapshot.flowId, flow);
  }

  private cleanupExpiredFlows(): void {
    const cutoff = this.now() - this.flowTtlMs;

    for (const [flowId, flow] of this.flows.entries()) {
      if (flow.snapshot.updatedAt >= cutoff) {
        continue;
      }

      if (flow.snapshot.status === 'pending') {
        flow.process?.kill('SIGTERM');
      }

      this.flows.delete(flowId);
      this.activeContextFlows.delete(flow.contextKey);
    }
  }

  private async startFlow(
    config: AgorConfig,
    options: SpawnCodexDeviceAuthProcessOptions,
    context: CodexDeviceAuthSpawnContext,
    contextKey: string
  ): Promise<CodexDeviceAuthFlow> {
    const { process, context: spawnedContext } = await this.spawnProcess(config, options, context);
    const startedAt = this.now();
    const flowId = randomUUID();
    const flow: ManagedCodexDeviceAuthFlow = {
      snapshot: {
        flowId,
        agorUserId: options.agorUserId,
        status: 'pending',
        verificationUri: null,
        userCode: null,
        codexHome: spawnedContext.codexHome,
        executionUnixUser: spawnedContext.executionUnixUser,
        error: null,
        createdAt: startedAt,
        updatedAt: startedAt,
      },
      process,
      contextKey,
    };

    this.flows.set(flowId, flow);
    this.activeContextFlows.set(contextKey, flowId);

    return await new Promise<CodexDeviceAuthFlow>((resolve, reject) => {
      let ready = false;
      let settled = false;
      let combinedOutput = '';

      const markFailed = (message: string) => {
        this.updateFlow(flow, {
          status: 'failed',
          error: message,
        });
        this.activeContextFlows.delete(contextKey);
      };

      const maybeResolveReady = () => {
        const parsed = parseDeviceAuthOutput(combinedOutput);
        if (parsed.verificationUri || parsed.userCode) {
          this.updateFlow(flow, {
            verificationUri: parsed.verificationUri,
            userCode: parsed.userCode,
          });
        }

        if (!ready && parsed.verificationUri && parsed.userCode) {
          ready = true;
          settled = true;
          resolve(flow.snapshot);
        }
      };

      const handleOutput = (chunk: string | Buffer) => {
        combinedOutput += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        maybeResolveReady();
      };

      process.stdout?.on('data', handleOutput);
      process.stderr?.on('data', handleOutput);

      process.on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        markFailed(error.message);
        reject(error);
      });

      process.on('exit', (code, signal) => {
        const finalMessage = combinedOutput.trim() || `codex login exited (${code ?? signal})`;
        if (flow.snapshot.status === 'cancelled') {
          return;
        }

        if (code === 0) {
          this.updateFlow(flow, {
            status: 'completed',
            error: null,
          });
        } else {
          markFailed(finalMessage);
        }

        flow.process = null;
        this.activeContextFlows.delete(contextKey);

        if (!settled && !ready) {
          settled = true;
          reject(new Error(finalMessage));
        }
      });
    });
  }
}
