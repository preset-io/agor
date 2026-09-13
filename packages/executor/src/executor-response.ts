import { PassThrough } from 'node:stream';
import {
  EXECUTOR_RESPONSE_CONTENT_TYPE,
  EXECUTOR_RESPONSE_MAX_EVENT_BYTES,
  EXECUTOR_RESPONSE_MAX_EVENTS,
  EXECUTOR_RESPONSE_PROTOCOL,
  EXECUTOR_RESPONSE_PROTOCOL_HEADER,
  EXECUTOR_RESPONSE_TOO_LARGE,
  type ExecutorCommandResult,
  type ExecutorResponseDescriptor,
  ExecutorResponseEventNameSchema,
  type ExecutorResponseFrame,
} from '@agor/core/executor-protocol';

type StreamingRequestInit = RequestInit & { duplex: 'half' };
const TERMINAL_RESERVE_BYTES = 512;

function writeWithBackpressure(stream: PassThrough, value: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      stream.write(value, (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

function tooLargeResult(maxResponseBytes: number): ExecutorCommandResult {
  return {
    success: false,
    error: {
      code: EXECUTOR_RESPONSE_TOO_LARGE,
      message: `Executor response exceeds the configured ${maxResponseBytes}-byte limit`,
      details: { maxResponseBytes },
    },
  };
}

/**
 * One HTTP request-body stream owned by a single executor invocation.
 * Events are ordered ahead of one terminal result. The bearer capability is
 * never placed in argv, URLs, logs, or environment variables.
 */
export class ExecutorResponsePublisher {
  private readonly body = new PassThrough();
  private response?: Promise<Response>;
  private readonly abort = new AbortController();
  private readonly deadlineTimer: ReturnType<typeof setTimeout>;
  private writeChain = Promise.resolve();
  private seq = 0;
  private bytesQueued = 0;
  private finalized = false;
  private overflowed = false;
  private eventCount = 0;

  constructor(private readonly descriptor: ExecutorResponseDescriptor) {
    const remainingMs = Math.max(1, Date.parse(descriptor.deadlineAt) - Date.now());
    this.deadlineTimer = setTimeout(() => this.abort.abort(), remainingMs);
  }

  private startResponse(): Promise<Response> {
    if (this.response) return this.response;
    this.response = fetch(this.descriptor.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.descriptor.token}`,
        'content-type': `${EXECUTOR_RESPONSE_CONTENT_TYPE}; charset=utf-8`,
        'cache-control': 'no-store',
        [EXECUTOR_RESPONSE_PROTOCOL_HEADER]: EXECUTOR_RESPONSE_PROTOCOL,
      },
      // Node's fetch accepts a Readable stream with duplex=half. The executor
      // tsconfig intentionally does not include DOM's BodyInit declaration.
      body: this.body as never,
      duplex: 'half',
      signal: this.abort.signal,
    } as StreamingRequestInit);
    // Event producers are intentionally synchronous. Observe an early network
    // rejection here; final() still awaits and surfaces the same rejection.
    void this.response.catch(() => undefined);
    return this.response;
  }

  emit(event: unknown): void {
    if (this.finalized) return;
    if (this.descriptor.profile !== 'events') {
      throw new Error('Executor response profile does not allow events');
    }
    if (this.eventCount >= EXECUTOR_RESPONSE_MAX_EVENTS) {
      throw new Error('Executor response event limit exceeded');
    }
    if (!event || typeof event !== 'object' || !('type' in event)) {
      throw new Error('Executor response event is invalid');
    }
    const { type, ...data } = event as Record<string, unknown>;
    const name = ExecutorResponseEventNameSchema.safeParse(type);
    if (!name.success) {
      throw new Error('Executor response event name is invalid');
    }
    const frame: ExecutorResponseFrame = {
      v: 1,
      requestId: this.descriptor.requestId,
      type: 'event',
      seq: this.seq,
      name: name.data,
      data,
    };
    if (this.enqueue(frame)) {
      this.startResponse();
      this.seq += 1;
      this.eventCount += 1;
    }
  }

  async final(result: ExecutorCommandResult): Promise<void> {
    if (this.finalized) throw new Error('Executor response already finalized');
    this.finalized = true;

    let frame: ExecutorResponseFrame = {
      v: 1,
      requestId: this.descriptor.requestId,
      type: 'final',
      seq: this.seq,
      result,
    };
    let line = `${JSON.stringify(frame)}\n`;
    if (
      this.overflowed ||
      this.bytesQueued + Buffer.byteLength(line) > this.descriptor.maxResponseBytes
    ) {
      frame = {
        v: 1,
        requestId: this.descriptor.requestId,
        type: 'final',
        seq: frame.seq,
        result: tooLargeResult(this.descriptor.maxResponseBytes),
      };
      line = `${JSON.stringify(frame)}\n`;
    }
    if (this.bytesQueued + Buffer.byteLength(line) > this.descriptor.maxResponseBytes) {
      this.body.destroy();
      this.abort.abort();
      clearTimeout(this.deadlineTimer);
      throw new Error('Executor response framing exceeds configured limit');
    }

    const responsePromise = this.startResponse();
    this.bytesQueued += Buffer.byteLength(line);
    this.writeChain = this.writeChain.then(() => writeWithBackpressure(this.body, line));
    try {
      await this.writeChain;
      this.body.end();
      const response = await responsePromise;
      if (response.status !== 204) {
        throw new Error(`Executor response receiver rejected the payload (${response.status})`);
      }
    } catch (error) {
      this.body.destroy();
      this.abort.abort();
      throw error;
    } finally {
      clearTimeout(this.deadlineTimer);
    }
  }

  private enqueue(frame: ExecutorResponseFrame): boolean {
    const line = `${JSON.stringify(frame)}\n`;
    const size = Buffer.byteLength(line);
    if (frame.type === 'event' && size > EXECUTOR_RESPONSE_MAX_EVENT_BYTES) {
      throw new Error('Executor response event exceeds the v1 event limit');
    }
    if (this.bytesQueued + size > this.descriptor.maxResponseBytes - TERMINAL_RESERVE_BYTES) {
      // Preserve ordering and let final() replace the terminal value with the
      // small typed overflow result. Current v1 events are deliberately tiny.
      this.overflowed = true;
      return false;
    }
    this.bytesQueued += size;
    this.writeChain = this.writeChain.then(() => writeWithBackpressure(this.body, line));
    void this.writeChain.catch(() => undefined);
    return true;
  }
}
