import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { MessagesService, StreamingCallbacks } from '../base/index.js';
import { type OmpConfig, OmpTool } from './omp-tool.js';

/**
 * Minimal stand-in for a spawned `omp --mode rpc` process.
 *
 * `emit()` writes frames the way a real pipe does — several JSON lines can
 * arrive in ONE stdout chunk, which is exactly the condition that used to
 * reorder streaming callbacks.
 *
 * The fake answers `get_state` and exits on `kill()` so the tool's own
 * post-turn request and disposal complete immediately instead of waiting out
 * their real timeouts.
 */
function fakeOmp() {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const sent: Array<Record<string, unknown>> = [];

  const write = (...frames: Array<Record<string, unknown>>) => {
    stdout.write(`${frames.map((f) => JSON.stringify(f)).join('\n')}\n`);
  };

  stdin.on('data', (buf: Buffer) => {
    for (const line of buf.toString().split('\n').filter(Boolean)) {
      const command: Record<string, unknown> = JSON.parse(line);
      sent.push(command);
      // Answer the bookkeeping calls the tool makes around every turn.
      if (command.type === 'get_state') {
        write({
          type: 'response',
          id: command.id,
          command: 'get_state',
          success: true,
          data: { sessionFile: '/s/abc.jsonl', contextUsage: { tokens: 10, contextWindow: 100 } },
        });
      }
    }
  });

  Object.assign(child, {
    stdout,
    stderr,
    stdin,
    kill: () => {
      // A real kill terminates the process; mirror that so dispose() resolves.
      queueMicrotask(() => child.emit('exit', 0, 'SIGTERM'));
      return true;
    },
  });

  return { child, write, sent };
}

function harness() {
  const omp = fakeOmp();
  const created: Array<Record<string, unknown>> = [];
  const messagesService = {
    create: vi.fn(async (m: Record<string, unknown>) => {
      created.push(m);
      return m;
    }),
  } as unknown as MessagesService;

  const events: string[] = [];
  const callbacks = {
    onStreamStart: vi.fn(async () => {
      events.push('start');
    }),
    onStreamChunk: vi.fn(async (_id: unknown, chunk: string, seq?: number) => {
      events.push(`chunk:${chunk}:${seq}`);
    }),
    onStreamEnd: vi.fn(async () => {
      events.push('end');
    }),
  } as unknown as StreamingCallbacks;

  const tool = new OmpTool(
    { enabled: true, spawnFn: (() => omp.child) as OmpConfig['spawnFn'] },
    messagesService
  );
  tool.setSessionContext({ workingDirectory: '/tmp' });

  /** Resolves once the tool has issued its `prompt` command. */
  const promptSent = () =>
    vi.waitFor(() => expect(omp.sent.some((c) => c.type === 'prompt')).toBe(true));

  return { omp, tool, callbacks, events, created, promptSent };
}

const READY = { type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1] };

describe('OmpTool streaming', () => {
  it('delivers text chunks in arrival order behind onStreamStart', async () => {
    // Regression: deltas were dispatched as independent `void (async () => …)`
    // tasks. onFrame runs synchronously from the stdout reader loop, so the
    // second delta skipped the not-yet-resolved onStreamStart and emitted
    // first — reversing the text and mis-numbering `sequence`.
    const { omp, tool, callbacks, events, promptSent } = harness();

    const run = tool.executeTask('s1', 'hi', 't1', callbacks, 1);
    omp.write(READY);
    await promptSent();

    // Four deltas in a single chunk, then the terminal frames.
    omp.write(
      { type: 'response', id: 'agor_1', command: 'prompt', success: true },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'A' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'B' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'C' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'D' } },
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ABCD' }] },
      },
      { type: 'agent_end' }
    );

    const result = await run;
    expect(result.status).toBe('completed');
    expect(events).toEqual(['start', 'chunk:A:1', 'chunk:B:2', 'chunk:C:3', 'chunk:D:4', 'end']);
  });

  it('starts the stream before any chunk and ends it last', async () => {
    const { omp, tool, callbacks, events, promptSent } = harness();
    const run = tool.executeTask('s1', 'hi', 't1', callbacks, 1);
    omp.write(READY);
    await promptSent();
    omp.write(
      { type: 'response', id: 'agor_1', command: 'prompt', success: true },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'y' } },
      { type: 'agent_end' }
    );
    await run;
    expect(events[0]).toBe('start');
    expect(events.at(-1)).toBe('end');
  });

  it('records the context snapshot and session file for the next turn', async () => {
    const { omp, tool, callbacks, promptSent } = harness();
    const run = tool.executeTask('s1', 'hi', 't1', callbacks, 1);
    omp.write(READY);
    await promptSent();
    omp.write(
      { type: 'response', id: 'agor_1', command: 'prompt', success: true },
      { type: 'agent_end' }
    );
    await run;

    expect(tool.getLastSessionFile()).toBe('/s/abc.jsonl');
    expect(tool.getLastContextUsage()).toEqual({
      totalTokens: 10,
      maxTokens: 100,
      percentage: 10,
    });
  });

  it('fails the turn when OMP rejects the prompt', async () => {
    const { omp, tool, callbacks, promptSent } = harness();
    const run = tool.executeTask('s1', 'hi', 't1', callbacks, 1);
    omp.write(READY);
    await promptSent();
    omp.write({
      type: 'response',
      id: 'agor_1',
      command: 'prompt',
      success: false,
      error: 'no model configured',
    });

    const result = await run;
    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('no model configured');
  });

  it('ends the turn when the process dies mid-stream instead of hanging', async () => {
    // Without the onExit hook this would sit on the 30-minute turn timeout.
    const { omp, tool, callbacks, promptSent } = harness();
    const run = tool.executeTask('s1', 'hi', 't1', callbacks, 1);
    omp.write(READY);
    await promptSent();
    omp.write({ type: 'response', id: 'agor_1', command: 'prompt', success: true });
    omp.child.emit('exit', 1, null);

    await expect(run).resolves.toMatchObject({ status: 'completed' });
  });

  it('persists a placeholder rather than an empty message when OMP says nothing', async () => {
    const { omp, tool, callbacks, created, promptSent } = harness();
    const run = tool.executeTask('s1', 'hi', 't1', callbacks, 1);
    omp.write(READY);
    await promptSent();
    omp.write(
      { type: 'response', id: 'agor_1', command: 'prompt', success: true },
      { type: 'agent_end' }
    );
    await run;

    const message = created.at(-1);
    expect(message?.content).toEqual([{ type: 'text', text: '(no output)' }]);
    expect(message?.content_preview).toBeDefined();
  });
});
