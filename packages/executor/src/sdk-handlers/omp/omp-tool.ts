/**
 * Oh My Pi tool implementation.
 *
 * Drives OMP as a subprocess over its JSONL RPC protocol (`omp --mode rpc`).
 * OMP's npm SDK ships raw TypeScript for the Bun runtime, so it cannot be
 * imported in-process by Agor's Node executor; RPC is the supported embedding
 * surface and it also happens to be the only path that preserves OMP's slash
 * commands.
 *
 * Capabilities:
 * - Streaming text and thinking deltas
 * - Structured tool-call blocks (`tool_execution_start` / `_end`)
 * - Token usage AND real USD cost, both self-reported by OMP
 * - Context-window snapshots via `get_state`
 * - Slash commands: a prompt starting with `/` is expanded by OMP, and
 *   local-only commands complete without an agent turn
 */

import { spawn } from 'node:child_process';
import { generateId, shortId } from '@agor/core';
import type { OmpFrame, OmpRpcClientOptions, OmpTurnResult } from '@agor/core/omp';
import {
  buildOmpEnv,
  ensureAgorMcpConfig,
  isSlashCommandPrompt,
  OmpRpcClient,
  OmpTurnAccumulator,
} from '@agor/core/omp';
import type { ContextUsageSnapshot, MessageID, SessionID, TaskID } from '@agor/core/types';
import { MessageRole } from '@agor/core/types';
import type { SessionRepository } from '../../db/feathers-repositories.js';
import type { NormalizedSdkResponse, RawSdkResponse } from '../../types/sdk-response.js';
import { enrichContentBlocks } from '../base/diff-enrichment.js';
import type {
  MessagesService,
  StreamingCallbacks,
  TaskResult,
  ToolCapabilities,
} from '../base/index.js';
import type { ITool } from '../base/tool.interface.js';

/** Grace period to drain `command_output` after a local-only slash command. */
const LOCAL_COMMAND_DRAIN_MS = 750;

/** Hard ceiling on a single OMP turn, so a wedged agent cannot hang the task. */
const TURN_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Ceiling for the prompt ACCEPTANCE ack, which OMP sends immediately — this is
 * not the turn budget (see `TURN_TIMEOUT_MS`).
 */
const PROMPT_ACK_TIMEOUT_MS = 60 * 1000;

export interface OmpConfig {
  enabled: boolean;
  /** Executable to spawn; defaults to `omp` on PATH. */
  binPath?: string;
  /** OMP profile Agor runs under. */
  profile?: string;
  /** Injection seam for tests, forwarded to the RPC client. */
  spawnFn?: OmpRpcClientOptions['spawnFn'];
}

interface OmpSessionContext {
  workingDirectory?: string;
  model?: string;
  provider?: string;
  mcpToken?: string;
  daemonUrl?: string;
  /**
   * OMP session file from a previous turn. Each Agor task spawns a fresh OMP
   * process, so this is what carries the conversation forward.
   */
  resumeRef?: string;
}

export class OmpTool implements ITool {
  readonly toolType = 'omp' as const;
  readonly name = 'Oh My Pi';

  private readonly config: OmpConfig;
  private readonly messagesService: MessagesService;
  private context: OmpSessionContext = {};
  private activeClient?: OmpRpcClient;
  /** Latest context-window reading, surfaced to Agor's task accounting. */
  private lastContextUsage?: ContextUsageSnapshot;
  /** OMP session file for the last turn, so the next task can resume it. */
  private lastSessionFile?: string;

  private readonly sessionsRepo?: SessionRepository;

  constructor(
    config: OmpConfig,
    messagesService: MessagesService,
    sessionsRepo?: SessionRepository
  ) {
    this.config = config;
    this.messagesService = messagesService;
    this.sessionsRepo = sessionsRepo;
  }

  /**
   * Persist the command set OMP advertises so the composer can autocomplete
   * `/` commands for this session, matching the Claude Code behaviour.
   */
  private async persistSlashCommands(sessionId: string, commands: string[]): Promise<void> {
    if (!this.sessionsRepo || commands.length === 0) return;
    try {
      // The repository deep-merges custom_context, so this only touches the key.
      await this.sessionsRepo.update(sessionId as SessionID, {
        custom_context: { slash_commands: commands },
      });
    } catch (error) {
      console.warn('[omp] Failed to persist slash commands to session:', error);
    }
  }

  getCapabilities(): ToolCapabilities {
    return {
      supportsSessionImport: false,
      supportsSessionCreate: true,
      supportsLiveExecution: true,
      supportsSessionFork: false,
      supportsChildSpawn: true,
      supportsGitState: false,
      supportsStreaming: true,
    };
  }

  /** Probe the binary by asking it for its version. */
  checkInstalled(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const child = spawn(this.config.binPath ?? 'omp', ['--version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
  }

  setSessionContext(context: OmpSessionContext): void {
    this.context = { ...this.context, ...context };
  }

  /** Context-window snapshot captured during the last turn, if any. */
  getLastContextUsage(): ContextUsageSnapshot | undefined {
    return this.lastContextUsage;
  }

  /**
   * OMP session file written by the last turn. The runner persists this on the
   * Agor session so the next task resumes the same conversation.
   */
  getLastSessionFile(): string | undefined {
    return this.lastSessionFile;
  }

  /**
   * Run one prompt to completion and persist the assistant message.
   *
   * A fresh OMP process is spawned per task. OMP keeps its own session file,
   * but Agor is the system of record for the transcript, so a per-task process
   * keeps failure domains small and abort semantics simple.
   */
  async executeTask(
    sessionId: string,
    prompt: string,
    taskId?: string,
    streamingCallbacks?: StreamingCallbacks,
    assistantIndex?: number
  ): Promise<TaskResult> {
    const accumulator = new OmpTurnAccumulator();
    const assistantMessageId = generateId() as MessageID;
    let streamStarted = false;
    let sequence = 0;
    let streamedPreview = '';
    /**
     * Serializes streaming callbacks.
     *
     * `onFrame` is invoked synchronously from the stdout reader's loop, so
     * several deltas can be dispatched before the first `await` resumes.
     * Firing an independent async task per delta would let a later chunk
     * overtake an earlier one — and overtake `onStreamStart` itself — so every
     * delta is appended to one chain instead.
     */
    let streamChain: Promise<void> = Promise.resolve();

    // Turn completion has two paths: a model turn ends with `agent_end`, while
    // a local-only slash command never invokes the agent at all. Both funnel
    // through `finishTurn`, which is idempotent.
    let turnFinished = false;
    let resolveTurn: () => void = () => undefined;
    let turnTimer: NodeJS.Timeout | undefined;
    const turnComplete = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    const finishTurn = (): void => {
      if (turnFinished) return;
      turnFinished = true;
      clearTimeout(turnTimer);
      accumulator.markEnded();
      resolveTurn();
    };
    turnTimer = setTimeout(() => {
      accumulator.recordError(`OMP turn exceeded ${TURN_TIMEOUT_MS}ms`);
      finishTurn();
    }, TURN_TIMEOUT_MS);

    // Register the Agor MCP endpoint so the agent's tool registry includes
    // Agor self-drive tools on the first turn.
    //
    // Gated on actually having a token: the entry lives in the user's own OMP
    // config, and its `${...}` placeholders do NOT resolve outside Agor — OMP
    // treats an unexpanded value literally and reports a failed server. So we
    // only add it for installs that genuinely use Agor's MCP.
    if (this.context.mcpToken && this.context.daemonUrl) {
      await ensureAgorMcpConfig({ profile: this.config.profile }).catch((error: unknown) => {
        console.warn('[omp] Could not write Agor MCP config:', error);
      });
    }

    const client = new OmpRpcClient({
      cwd: this.context.workingDirectory ?? process.cwd(),
      binPath: this.config.binPath,
      profile: this.config.profile,
      model: this.context.model,
      resume: this.context.resumeRef,
      spawnFn: this.config.spawnFn,
      env: buildOmpEnv({
        base: process.env,
        daemonUrl: this.context.daemonUrl,
        mcpToken: this.context.mcpToken,
        profile: this.config.profile,
      }),
      onStderr: (text) => {
        if (text.trim()) console.warn(`[omp:stderr] ${text.trimEnd()}`);
      },
      // The process dying is a terminal condition for the turn.
      onExit: () => finishTurn(),
      onFrame: (frame) => {
        this.observeCompletion(frame, finishTurn);
        const delta = accumulator.handle(frame);
        if (!delta || !streamingCallbacks) return;
        // Agor renders one streaming surface per message; thinking deltas are
        // captured into blocks at message_end rather than streamed as text.
        if (delta.kind !== 'text') return;
        streamChain = streamChain
          .then(async () => {
            if (!streamStarted) {
              streamStarted = true;
              await streamingCallbacks.onStreamStart(assistantMessageId, {
                session_id: sessionId as SessionID,
                task_id: taskId as TaskID | undefined,
                role: 'assistant',
                timestamp: new Date().toISOString(),
              });
            }
            sequence += 1;
            streamedPreview += delta.text;
            await streamingCallbacks.onStreamChunk(assistantMessageId, delta.text, sequence);
          })
          .catch((error: unknown) => {
            console.warn('[omp] Streaming callback failed:', error);
          });
      },
    });
    this.activeClient = client;

    try {
      await client.start();
      await this.applyModelSelection(client);

      // `prompt` is acknowledged on ACCEPTANCE, not on completion — the turn
      // itself finishes via the frames observed above.
      //
      // The ack is raced against turn completion so a wedged OMP that accepts
      // the prompt but never acks cannot hang the task forever: `agent_end`,
      // process exit, or the turn timeout all release us. Waiting on the ack
      // alone would make the turn timer unreachable, since it only resolves
      // `turnComplete`.
      const ack = client.request({ type: 'prompt', message: prompt }, PROMPT_ACK_TIMEOUT_MS);
      // Swallow a late rejection; the race below already decided the outcome.
      ack.catch(() => undefined);
      const response = await Promise.race([ack, turnComplete.then(() => undefined)]);

      if (response && !response.success) {
        throw new Error(response.error ?? 'OMP rejected the prompt');
      }
      if (response && this.isLocalOnlyAck(response.data)) {
        // Let queued `command_output` frames land before closing the turn.
        setTimeout(finishTurn, isSlashCommandPrompt(prompt) ? LOCAL_COMMAND_DRAIN_MS : 0);
      }
      await turnComplete;
      // Drain queued chunks so `streamedPreview` is complete before it is used
      // as a preview fallback, and so no chunk lands after `onStreamEnd`.
      await streamChain;

      await this.captureContextUsage(client);

      const result = accumulator.result();
      await this.persistSlashCommands(sessionId, result.slashCommands);
      await this.persistAssistantMessage({
        sessionId,
        taskId,
        assistantMessageId,
        assistantIndex,
        result,
        streamedPreview,
      });

      if (streamStarted && streamingCallbacks) {
        await streamingCallbacks.onStreamEnd(assistantMessageId);
      }

      return {
        taskId: taskId ?? '',
        status: result.hadError ? 'failed' : 'completed',
        messages: [],
        completedAt: new Date(),
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[omp] executeTask failed:', err);
      if (streamStarted && streamingCallbacks) {
        await streamingCallbacks.onStreamEnd(assistantMessageId).catch(() => undefined);
      }
      return {
        taskId: taskId ?? '',
        status: 'failed',
        messages: [],
        error: err,
        completedAt: new Date(),
      };
    } finally {
      clearTimeout(turnTimer);
      this.activeClient = undefined;
      await client.dispose().catch(() => undefined);
    }
  }

  /** Close the turn when OMP signals the agent finished, or resolved locally. */
  private observeCompletion(frame: OmpFrame, finishTurn: () => void): void {
    if (frame.type === 'agent_end') {
      finishTurn();
      return;
    }
    if (frame.type !== 'prompt_result') return;
    if ('agentInvoked' in frame && frame.agentInvoked === false) {
      setTimeout(finishTurn, LOCAL_COMMAND_DRAIN_MS);
    }
  }

  /**
   * `agentInvoked: false` means OMP handled the prompt without a model turn —
   * typically a slash command that printed output directly.
   */
  private isLocalOnlyAck(data: unknown): boolean {
    if (typeof data !== 'object' || data === null || !('agentInvoked' in data)) return false;
    return data.agentInvoked === false;
  }

  /** Apply the session's configured model, if Agor has one pinned. */
  private async applyModelSelection(client: OmpRpcClient): Promise<void> {
    const { model, provider } = this.context;
    if (!model || !provider) return;
    const response = await client
      .request({ type: 'set_model', provider, modelId: model }, 15_000)
      .catch(() => undefined);
    if (response && !response.success) {
      console.warn(`[omp] set_model(${provider}/${model}) failed: ${response.error}`);
    }
  }

  /**
   * Read OMP's post-turn state: context-window occupancy for task accounting,
   * and the session file so the next turn can resume this conversation.
   */
  private async captureContextUsage(client: OmpRpcClient): Promise<void> {
    const response = await client.request({ type: 'get_state' }, 15_000).catch(() => undefined);
    if (!response?.success) return;
    const data = response.data;
    if (typeof data !== 'object' || data === null) return;
    if ('sessionFile' in data && typeof data.sessionFile === 'string' && data.sessionFile) {
      this.lastSessionFile = data.sessionFile;
    }
    if (!('contextUsage' in data)) return;
    const usage = data.contextUsage;
    if (typeof usage !== 'object' || usage === null) return;
    // OMP's payload is external input, so each field is checked, not assumed.
    const read = (key: string): number | undefined => {
      if (!(key in usage)) return undefined;
      const value: unknown = Reflect.get(usage, key);
      return typeof value === 'number' ? value : undefined;
    };
    const tokens = read('tokens');
    const contextWindow = read('contextWindow');
    if (tokens === undefined || contextWindow === undefined || contextWindow <= 0) return;
    const percent = read('percent');
    this.lastContextUsage = {
      totalTokens: tokens,
      maxTokens: contextWindow,
      percentage: Math.round(percent ?? (tokens / contextWindow) * 100),
    };
  }

  private async persistAssistantMessage(params: {
    sessionId: string;
    taskId?: string;
    assistantMessageId: MessageID;
    assistantIndex?: number;
    result: OmpTurnResult;
    streamedPreview: string;
  }): Promise<void> {
    const { result } = params;
    const contentBlocks = [...result.contentBlocks];
    if (contentBlocks.length === 0) {
      contentBlocks.push({ type: 'text', text: params.streamedPreview.trim() || '(no output)' });
    }
    // Attach structuredPatch data so edit/write results render as diffs.
    enrichContentBlocks(contentBlocks);

    const preview = contentBlocks
      .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join(' ')
      .slice(0, 200);

    await this.messagesService.create({
      message_id: params.assistantMessageId,
      session_id: params.sessionId as SessionID,
      task_id: params.taskId as TaskID | undefined,
      type: 'assistant' as const,
      role: MessageRole.ASSISTANT,
      index: params.assistantIndex ?? 0,
      timestamp: new Date().toISOString(),
      content_preview: preview || params.streamedPreview.slice(0, 200),
      content: contentBlocks,
      tool_uses: result.toolUses.length > 0 ? result.toolUses : undefined,
      metadata: {
        omp: {
          model: result.model,
          provider: result.provider,
          stopReason: result.stopReason,
          usage: result.usage,
          commandOutputs: result.commandOutputs.length > 0 ? result.commandOutputs : undefined,
        },
      },
    });
  }

  /** Interrupt the in-flight turn. */
  async stopTask(
    sessionId: string,
    taskId?: string
  ): Promise<{ success: boolean; partialResult?: Partial<TaskResult>; reason?: string }> {
    const client = this.activeClient;
    if (!client) {
      return { success: false, reason: 'No active OMP session to stop' };
    }
    console.log(`[omp] Aborting task ${taskId ? shortId(taskId) : ''} in ${shortId(sessionId)}`);
    await client.abort();
    return { success: true, partialResult: { status: 'cancelled' } };
  }

  normalizedSdkResponse(_rawResponse: RawSdkResponse): NormalizedSdkResponse {
    throw new Error(
      'normalizedSdkResponse() is deprecated - use normalizeRawSdkResponse() from utils/sdk-normalizer instead'
    );
  }
}
