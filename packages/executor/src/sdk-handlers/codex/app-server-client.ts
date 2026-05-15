import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

interface JsonRpcResponse<T = unknown> {
  id: number;
  result?: T;
  error?: { message?: string; code?: number; data?: unknown };
}

interface ThreadForkResult {
  thread?: { id?: string };
}

export interface CodexAppServerClientOptions {
  /** Extra env values to pass to the spawned `codex app-server` process. */
  env?: NodeJS.ProcessEnv;
  /** Request timeout for initialize/fork calls. Defaults to 10s. */
  timeoutMs?: number;
  /** Override executable for tests or non-standard installs. Defaults to `codex`. */
  command?: string;
}

/**
 * Minimal JSONL client for Codex's local App Server.
 *
 * This intentionally implements only the `thread/fork` sidecar operation so
 * Agor can keep using `@openai/codex-sdk` for normal streaming execution. The
 * App Server is spawned, initialized, asked to fork one stored thread, then
 * torn down immediately.
 */
export class CodexAppServerClient {
  private readonly timeoutMs: number;
  private readonly command: string;
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

  constructor(private readonly options: CodexAppServerClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.command = options.command ?? 'codex';
  }

  async forkThread(threadId: string): Promise<string> {
    await this.start();
    await this.request('initialize', {
      clientInfo: { name: 'agor', title: 'Agor', version: '0.0.0' },
    });
    this.sendNotification('initialized', {});

    const result = await this.request<ThreadForkResult>('thread/fork', { threadId });
    const forkedThreadId = result.thread?.id;
    if (!forkedThreadId) {
      throw new Error(
        `Codex app-server thread/fork returned no thread id: ${JSON.stringify(result)}`
      );
    }
    return forkedThreadId;
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

    this.startPromise = new Promise<void>((resolve, reject) => {
      const child = spawn(this.command, ['app-server'], {
        env: { ...process.env, ...this.options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;

      const rejectStartup = (error: Error) => {
        this.rejectAll(error);
        reject(error);
      };

      child.once('error', (error) => {
        rejectStartup(new Error(`Failed to start Codex app-server: ${error.message}`));
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
        new Error(
          `Codex app-server request failed: ${
            response.error.message ?? JSON.stringify(response.error)
          }`
        )
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
