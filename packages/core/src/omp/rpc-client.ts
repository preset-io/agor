/**
 * Client for Oh My Pi's JSONL RPC protocol (`omp --mode rpc`).
 *
 * Owns the subprocess lifecycle, stdout framing, protocol-v2 chunk
 * reassembly, and request/response correlation. It is deliberately transport
 * only: translating OMP events into Agor messages is `event-translator.ts`,
 * and deciding what to do with them is the executor's `OmpTool`.
 *
 * Why a subprocess rather than an in-process SDK: OMP's npm package ships raw
 * TypeScript and targets the Bun runtime, so Agor's Node executor cannot
 * import it. The RPC protocol is OMP's supported embedding surface.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import {
  isOmpFrame,
  type OmpCommand,
  type OmpFrame,
  type OmpReadyFrame,
  type OmpResponseFrame,
} from './event-types.js';

/** Largest reassembled logical frame we will buffer, matching OMP's default. */
const DEFAULT_MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;

/** How long to wait for the `ready` frame before giving up on the process. */
const READY_TIMEOUT_MS = 30_000;

/** Default ceiling for a correlated request. Prompts are NOT bounded by this. */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export interface OmpRpcClientOptions {
  /** Working directory for the agent — normally the Agor branch worktree. */
  cwd: string;
  /** Executable to spawn. Defaults to `omp` resolved from PATH. */
  binPath?: string;
  /**
   * OMP profile name. Optional: when omitted OMP runs under the host user's
   * default profile, inheriting their existing login.
   */
  profile?: string;
  /** Model pattern passed through to `--model` (OMP fuzzy-matches it). */
  model?: string;
  /**
   * Prior OMP session to resume (`--resume`), by session-file path or id
   * prefix. Carries conversation state across Agor turns, which each spawn a
   * fresh process.
   */
  resume?: string;
  /** Extra CLI arguments appended verbatim. */
  extraArgs?: string[];
  /** Environment for the child. Merged over `process.env` by the caller. */
  env?: NodeJS.ProcessEnv;
  /** Receives every decoded stdout frame, in order. */
  onFrame?: (frame: OmpFrame) => void;
  /** Receives raw stderr text (OMP logs diagnostics here). */
  onStderr?: (text: string) => void;
  /** Invoked once the process exits, for whatever reason. */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  /** Injection seam for tests. */
  spawnFn?: typeof spawn;
}

/** Structural check for a `response` frame, validated rather than asserted. */
function asResponseFrame(frame: OmpFrame): OmpResponseFrame | undefined {
  if (frame.type !== 'response') return undefined;
  if (!('command' in frame) || typeof frame.command !== 'string') return undefined;
  if (!('success' in frame) || typeof frame.success !== 'boolean') return undefined;
  const id = 'id' in frame && typeof frame.id === 'string' ? frame.id : undefined;
  const error = 'error' in frame && typeof frame.error === 'string' ? frame.error : undefined;
  return {
    type: 'response',
    id,
    command: frame.command,
    success: frame.success,
    data: 'data' in frame ? frame.data : undefined,
    error,
  };
}

interface ChunkAccumulator {
  chunkId: string;
  count: number;
  /** Declared total size of the logical frame, as advertised by OMP. */
  byteLength: number;
  /** Base64 characters actually buffered so far. */
  buffered: number;
  parts: string[];
  received: number;
}

/** Fields carried by a protocol-v2 `rpc_chunk` frame, once validated. */
interface ChunkFrame {
  chunkId: string;
  index: number;
  count: number;
  byteLength: number;
  data: string;
}

/**
 * Validate a `rpc_chunk` frame. Returns undefined when the frame is malformed,
 * which the caller treats as lost framing and drops the partial buffer.
 */
function asChunkFrame(frame: OmpFrame): ChunkFrame | undefined {
  if (!('chunkId' in frame && 'index' in frame && 'count' in frame && 'data' in frame)) {
    return undefined;
  }
  const { chunkId, index, count, data } = frame;
  if (typeof chunkId !== 'string' || typeof data !== 'string') return undefined;
  if (typeof index !== 'number' || typeof count !== 'number') return undefined;
  const rawByteLength = 'byteLength' in frame ? frame.byteLength : 0;
  return {
    chunkId,
    index,
    count,
    byteLength: typeof rawByteLength === 'number' ? rawByteLength : 0,
    data,
  };
}

interface PendingRequest {
  resolve: (response: OmpResponseFrame) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

export class OmpRpcClient {
  private readonly options: OmpRpcClientOptions;
  private child?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = '';
  private readonly pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private chunk?: ChunkAccumulator;
  private maxReassembledBytes = DEFAULT_MAX_REASSEMBLED_BYTES;
  private readyFrame?: OmpReadyFrame;
  private exited = false;
  private exitError?: Error;

  constructor(options: OmpRpcClientOptions) {
    this.options = options;
  }

  /** True once the process has exited (cleanly or not). */
  get isExited(): boolean {
    return this.exited;
  }

  /** The negotiated ready frame, available after `start()` resolves. */
  get ready(): OmpReadyFrame | undefined {
    return this.readyFrame;
  }

  /** Build the argv for `omp --mode rpc`, exposed for spawn-config tests. */
  static buildArgs(
    options: Pick<OmpRpcClientOptions, 'profile' | 'model' | 'resume' | 'extraArgs'>
  ): string[] {
    const args = ['--mode', 'rpc'];
    if (options.profile) args.push('--profile', options.profile);
    if (options.model) args.push('--model', options.model);
    if (options.resume) args.push('--resume', options.resume);
    if (options.extraArgs?.length) args.push(...options.extraArgs);
    return args;
  }

  /**
   * Spawn OMP and resolve once it advertises readiness.
   *
   * Negotiates protocol v2 when offered so oversized frames arrive losslessly
   * as `rpc_chunk` sequences instead of being truncated.
   */
  async start(): Promise<OmpReadyFrame> {
    if (this.child) throw new Error('OmpRpcClient already started');

    const spawnFn = this.options.spawnFn ?? spawn;
    const child = spawnFn(this.options.binPath ?? 'omp', OmpRpcClient.buildArgs(this.options), {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text: string) => {
      this.consumeStdout(text);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text: string) => {
      this.options.onStderr?.(text);
    });

    const readyPromise = new Promise<OmpReadyFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`OMP did not become ready within ${READY_TIMEOUT_MS}ms`));
      }, READY_TIMEOUT_MS);

      this.onReady = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.onEarlyFailure = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });

    child.on('error', (error) => {
      const wrapped =
        'code' in error && error.code === 'ENOENT'
          ? new Error(
              `Oh My Pi binary not found (tried "${this.options.binPath ?? 'omp'}"). ` +
                'Install OMP and make sure it is on PATH for the Agor executor.'
            )
          : error;
      this.failAll(wrapped);
      this.onEarlyFailure?.(wrapped);
    });

    child.on('exit', (code, signal) => {
      this.exited = true;
      const error = new Error(`OMP exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      this.exitError = error;
      this.failAll(error);
      this.onEarlyFailure?.(error);
      this.options.onExit?.(code, signal);
    });

    const frame = await readyPromise;
    this.readyFrame = frame;
    if (typeof frame.maxReassembledFrameBytes === 'number') {
      this.maxReassembledBytes = frame.maxReassembledFrameBytes;
    }
    if (frame.supportedProtocolVersions?.includes(2)) {
      // Best effort: a v1-only server simply rejects it and we stay on v1.
      await this.request({ type: 'negotiate_protocol', protocolVersion: 2 }).catch(() => undefined);
    }
    return frame;
  }

  private onReady?: (frame: OmpReadyFrame) => void;
  private onEarlyFailure?: (error: Error) => void;

  /** Split the stdout stream into lines and dispatch each decoded frame. */
  private consumeStdout(text: string): void {
    this.stdoutBuffer += text;
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.trim()) {
        // This runs inside a stream 'data' listener: an escaping throw would be
        // an uncaught exception and take the executor process down. A bad frame
        // must degrade to a dropped frame, never a crash.
        try {
          this.handleLine(line);
        } catch (error) {
          this.options.onStderr?.(
            `[omp-rpc] dropped frame: ${error instanceof Error ? error.message : String(error)}\n`
          );
        }
      }
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A non-JSON line is diagnostic noise, not a protocol frame.
      this.options.onStderr?.(line);
      return;
    }
    if (!isOmpFrame(parsed)) return;

    if (parsed.type === 'rpc_chunk') {
      const reassembled = this.accumulateChunk(parsed);
      if (reassembled) this.dispatch(reassembled);
      return;
    }
    this.dispatch(parsed);
  }

  /**
   * Reassemble a protocol-v2 chunk sequence.
   *
   * Chunks must arrive as an uninterrupted run sharing one `chunkId`; anything
   * else means we lost framing, so the partial buffer is dropped.
   */
  private accumulateChunk(frame: OmpFrame): OmpFrame | undefined {
    const chunk = asChunkFrame(frame);
    if (!chunk) {
      this.chunk = undefined;
      return undefined;
    }
    if (!this.chunk || this.chunk.chunkId !== chunk.chunkId) {
      this.chunk = {
        chunkId: chunk.chunkId,
        count: chunk.count,
        byteLength: chunk.byteLength,
        buffered: 0,
        parts: new Array<string>(chunk.count).fill(''),
        received: 0,
      };
    }
    const acc = this.chunk;
    if (chunk.index < 0 || chunk.index >= acc.count) {
      this.chunk = undefined;
      return undefined;
    }
    // Bound on bytes ACTUALLY buffered, not the declared `byteLength` of the
    // first chunk — a sequence of small chunks must not be able to grow the
    // buffer past the negotiated ceiling unchecked.
    acc.buffered += chunk.data.length;
    if (acc.buffered > this.maxReassembledBytes || acc.byteLength > this.maxReassembledBytes) {
      this.chunk = undefined;
      throw new Error('OMP frame exceeded the negotiated reassembly limit');
    }
    if (acc.parts[chunk.index] === '') acc.received += 1;
    acc.parts[chunk.index] = chunk.data;
    if (acc.received < acc.count) return undefined;

    this.chunk = undefined;
    const decoded = Buffer.from(acc.parts.join(''), 'base64').toString('utf8');
    try {
      const parsed: unknown = JSON.parse(decoded);
      return isOmpFrame(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private dispatch(frame: OmpFrame): void {
    if (frame.type === 'ready') {
      const supported =
        'supportedProtocolVersions' in frame && Array.isArray(frame.supportedProtocolVersions)
          ? frame.supportedProtocolVersions.filter((v): v is number => typeof v === 'number')
          : undefined;
      const protocolVersion =
        'protocolVersion' in frame && typeof frame.protocolVersion === 'number'
          ? frame.protocolVersion
          : 1;
      const maxReassembledFrameBytes =
        'maxReassembledFrameBytes' in frame && typeof frame.maxReassembledFrameBytes === 'number'
          ? frame.maxReassembledFrameBytes
          : undefined;
      this.onReady?.({
        type: 'ready',
        protocolVersion,
        supportedProtocolVersions: supported,
        maxReassembledFrameBytes,
      });
    }

    const response = asResponseFrame(frame);
    if (response?.id) {
      const pending = this.pending.get(response.id);
      if (pending) {
        this.pending.delete(response.id);
        clearTimeout(pending.timer);
        pending.resolve(response);
      }
    }

    this.options.onFrame?.(frame);
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  /** Write a command without waiting for its response. */
  send(command: OmpCommand): void {
    if (!this.child || this.exited) {
      throw this.exitError ?? new Error('OMP process is not running');
    }
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  /**
   * Send a command and await its correlated response.
   *
   * `timeoutMs = 0` waits indefinitely — used for `prompt`, which OMP
   * acknowledges immediately but whose turn completes via `agent_end`.
   */
  request(
    command: OmpCommand,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<OmpResponseFrame> {
    this.requestCounter += 1;
    const id = `agor_${this.requestCounter}`;
    return new Promise<OmpResponseFrame>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`OMP command "${command.type}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pending.set(id, pending);
      try {
        this.send({ ...command, id });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Ask OMP to stop the in-flight turn. */
  async abort(): Promise<void> {
    if (!this.child || this.exited) return;
    await this.request({ type: 'abort' }, 10_000).catch(() => undefined);
  }

  /** Close stdin and terminate the child, escalating to SIGKILL if needed. */
  async dispose(): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    this.failAll(new Error('OMP client disposed'));
    try {
      child.stdin.end();
    } catch {
      // stdin may already be torn down; termination below is what matters.
    }
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3_000);
      child.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
}
