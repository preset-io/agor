import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  resolveManagedAgenticToolPackageDirectory,
  resolveManagedAgenticToolVersion,
} from '@agor/core/agentic-integrations';
import { sanitizeMCPExternalError } from '@agor/core/mcp';

interface JsonRpcResponse<T = unknown> {
  id: number;
  result?: T;
  error?: { message?: string; code?: number; data?: unknown };
}

interface ThreadForkResult {
  thread?: { id?: string };
}

/**
 * One installed skill as reported by the app-server's `skills/list`.
 * Codex flattens plugin-shipped skills into this list with
 * `name = "<plugin>:<skill>"` and `pluginId` set, so plugins need no
 * separate discovery call.
 */
export interface CodexDiscoveredSkill {
  name: string;
  description?: string;
  enabled?: boolean;
  scope?: string;
  pluginId?: string | null;
}

interface SkillsListResult {
  data?: Array<{ cwd?: string; skills?: unknown[] }>;
}

/**
 * Flatten a `skills/list` response into unique, enabled skills. Exported for
 * unit tests; tolerant of shape drift because the app-server protocol is
 * still marked experimental upstream.
 */
export function extractCodexSkillsFromListResponse(result: unknown): CodexDiscoveredSkill[] {
  const groups = (result as SkillsListResult | undefined)?.data;
  if (!Array.isArray(groups)) return [];

  const byName = new Map<string, CodexDiscoveredSkill>();
  for (const group of groups) {
    if (!Array.isArray(group?.skills)) continue;
    for (const raw of group.skills) {
      if (!raw || typeof raw !== 'object') continue;
      const skill = raw as Record<string, unknown>;
      const name = typeof skill.name === 'string' ? skill.name.trim() : '';
      if (!name || skill.enabled === false || byName.has(name)) continue;
      byName.set(name, {
        name,
        description: typeof skill.description === 'string' ? skill.description : undefined,
        enabled: typeof skill.enabled === 'boolean' ? skill.enabled : undefined,
        scope: typeof skill.scope === 'string' ? skill.scope : undefined,
        pluginId: typeof skill.pluginId === 'string' ? skill.pluginId : undefined,
      });
    }
  }
  return [...byName.values()];
}

export interface CodexAppServerClientOptions {
  /** Complete env to pass to the spawned app-server process. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Request timeout for initialize/app-server calls. Defaults to 10s. */
  timeoutMs?: number;
  /** Override executable for tests or non-standard installs. */
  command?: string;
}

interface CodexAppServerLaunch {
  command: string;
  args: string[];
}

/**
 * Resolve the CLI shipped with the same Codex integration as the SDK. A
 * packaged Agor install deliberately keeps agentic-tool runtimes outside
 * PATH, and a developer may also have a newer unrelated global `codex`, so
 * spawning by bare command would make app-server behavior version-dependent.
 */
async function resolveCodexAppServerLaunch(
  commandOverride?: string
): Promise<CodexAppServerLaunch> {
  if (commandOverride) return { command: commandOverride, args: ['app-server'] };

  let codexPackageDirectory: string;
  if (process.env.AGOR_MANAGED_AGENTIC_TOOLS === '1') {
    const agorVersion = resolveManagedAgenticToolVersion();
    if (!agorVersion) {
      throw new Error('AGOR_VERSION is missing from the packaged Codex runtime');
    }
    codexPackageDirectory = await resolveManagedAgenticToolPackageDirectory(
      'codex',
      agorVersion,
      '@openai/codex'
    );
  } else {
    // Resolve the transitive CLI from the SDK's own dependency tree rather
    // than from the executor package or the operator's PATH.
    const sdkRequire = createRequire(import.meta.resolve('@openai/codex-sdk'));
    codexPackageDirectory = dirname(sdkRequire.resolve('@openai/codex/package.json'));
  }

  return {
    command: process.execPath,
    args: [join(codexPackageDirectory, 'bin', 'codex.js'), 'app-server'],
  };
}

/**
 * Minimal JSONL client for Codex's local App Server.
 *
 * This intentionally implements only sidecar operations (`thread/fork`,
 * `skills/list`) so Agor can keep using `@openai/codex-sdk` for normal
 * streaming execution. The App Server is spawned, initialized, asked one
 * question, then torn down immediately.
 */
export class CodexAppServerClient {
  private readonly timeoutMs: number;
  private readonly command?: string;
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private stderr = '';
  private startPromise?: Promise<void>;
  private initPromise?: Promise<void>;

  constructor(private readonly options: CodexAppServerClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.command = options.command;
  }

  async forkThread(threadId: string): Promise<string> {
    await this.initialize();

    const result = await this.request<ThreadForkResult>('thread/fork', { threadId });
    const forkedThreadId = result.thread?.id;
    if (!forkedThreadId) {
      throw new Error(
        `Codex app-server thread/fork returned no thread id: ${JSON.stringify(result)}`
      );
    }
    return forkedThreadId;
  }

  /**
   * List installed skills visible to Codex for the given working directories
   * (user/system/plugin skills plus repo-scoped skills under each cwd).
   * `skills/list` defaults to the app-server process cwd when `cwds` is empty,
   * so callers should always pass the branch path. Discovery forces a rescan;
   * the higher-level Session TTL bounds that filesystem work.
   */
  async listSkills(cwds: string[]): Promise<CodexDiscoveredSkill[]> {
    await this.initialize();

    const result = await this.request<unknown>('skills/list', { cwds, forceReload: true });
    return extractCodexSkillsFromListResponse(result);
  }

  private async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await this.start();
        await this.request('initialize', {
          clientInfo: { name: 'agor', title: 'Agor', version: '0.0.0' },
        });
        this.sendNotification('initialized', {});
      })();
    }
    return this.initPromise;
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;

    this.child = undefined;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Codex app-server closed before response ${id}`));
    }
    this.pending.clear();

    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timedOut = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        resolve();
      }, 1_000).unref();
    });
    await Promise.race([exited, timedOut]);
  }

  private async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      const launch = await resolveCodexAppServerLaunch(this.command);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(launch.command, launch.args, {
          // `buildAppServerEnv()` passes a complete snapshot and intentionally
          // deletes ambient API keys in subscription mode. Do not merge
          // process.env back in here or those credentials are reintroduced.
          env: this.options.env ?? process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.child = child;

        const rejectStartup = (error: Error) => {
          this.rejectAll(error);
          reject(error);
        };

        child.once('error', (error) => {
          rejectStartup(new Error(sanitizeMCPExternalError(error, { stage: 'runtime' }).message));
        });

        child.once('spawn', () => resolve());

        child.stderr.on('data', (chunk: Buffer) => {
          this.stderr += chunk.toString('utf8');
          // Keep error payloads useful without unbounded memory growth.
          if (this.stderr.length > 20_000) this.stderr = this.stderr.slice(-20_000);
        });

        child.once('exit', (code, signal) => {
          this.rejectAll(
            new Error(
              `Codex app-server exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'}).${
                this.stderr ? ` stderr: ${this.stderr}` : ''
              }`
            )
          );
        });

        const rl = createInterface({ input: child.stdout });
        rl.on('line', (line) => this.handleLine(line));
      });
    })();

    return this.startPromise;
  }

  private request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const child = this.child;
    if (!child) throw new Error('Codex app-server is not running');

    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Timed out waiting for Codex app-server response to ${method}.${
              this.stderr ? ` stderr: ${this.stderr}` : ''
            }`
          )
        );
      }, this.timeoutMs);
      timer.unref();

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });

    child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    return promise;
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    const child = this.child;
    if (!child) throw new Error('Codex app-server is not running');
    child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== 'object' || !('id' in parsed)) return;
    const response = parsed as JsonRpcResponse;
    const pending = this.pending.get(response.id);
    if (!pending) return;

    this.pending.delete(response.id);
    clearTimeout(pending.timer);

    if (response.error) {
      pending.reject(
        new Error(sanitizeMCPExternalError(response.error, { stage: 'runtime' }).message)
      );
      return;
    }

    pending.resolve(response.result);
  }

  private rejectAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export async function forkCodexThreadViaAppServer(
  threadId: string,
  options?: CodexAppServerClientOptions
): Promise<string> {
  const client = new CodexAppServerClient(options);
  try {
    return await client.forkThread(threadId);
  } finally {
    await client.close();
  }
}

/**
 * One-shot `skills/list` lookup: spawn the app-server, list skills for the
 * given working directories, tear the process down.
 */
export async function listCodexSkillsViaAppServer(
  cwds: string[],
  options?: CodexAppServerClientOptions
): Promise<CodexDiscoveredSkill[]> {
  const client = new CodexAppServerClient(options);
  try {
    return await client.listSkills(cwds);
  } finally {
    await client.close();
  }
}
