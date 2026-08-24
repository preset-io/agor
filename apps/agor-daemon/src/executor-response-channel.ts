import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  EXECUTOR_RESPONSE_CONTENT_TYPE,
  EXECUTOR_RESPONSE_MAX_EVENT_BYTES,
  EXECUTOR_RESPONSE_MAX_EVENTS,
  EXECUTOR_RESPONSE_PROTOCOL,
  EXECUTOR_RESPONSE_PROTOCOL_HEADER,
  EXECUTOR_RESPONSE_TOO_LARGE,
  type ExecutorCommandResult,
  type ExecutorResponseDescriptor,
  ExecutorResponseFrameSchema,
} from '@agor/core/executor-protocol';
import type { Request, Response } from 'express';
import { type DaemonMetrics, getDaemonMetrics, NOOP_METRICS } from './metrics/index.js';

const RESPONSE_PATH = '/internal/executor-responses/v1';

export interface ExecutorResponseChannelRuntimeConfig {
  originUrl: string;
  maxResponseBytes: number;
  maxActiveRequests: number;
}

export interface ExecutorResponseReservation {
  descriptor: ExecutorResponseDescriptor;
  result: Promise<ExecutorCommandResult>;
  fail(result: ExecutorCommandResult): boolean;
  setFailureCleanup(cleanup: (result: ExecutorCommandResult) => void): void;
}

export class ExecutorResponseAdmissionError extends Error {
  constructor(readonly result: ExecutorCommandResult) {
    super(result.error?.message ?? 'Executor response request was not admitted');
  }
}

interface PendingResponse {
  requestId: string;
  tokenHash: Buffer;
  tenantId?: string;
  userId?: string;
  command: string;
  branchId?: string;
  sessionId?: string;
  deadlineAt: number;
  createdAt: number;
  maxResponseBytes: number;
  profile: ExecutorResponseDescriptor['profile'];
  nextSeq: number;
  eventCount: number;
  publisherActive: boolean;
  settled: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve(result: ExecutorCommandResult): void;
  onEvent?: (event: unknown) => void;
  failureCleanup?: (result: ExecutorCommandResult) => void;
  closePublisher?: () => void;
}

let runtimeConfig: ExecutorResponseChannelRuntimeConfig = {
  originUrl: 'http://localhost:3030',
  maxResponseBytes: 8 * 1024 * 1024,
  maxActiveRequests: 16,
};

const pending = new Map<string, PendingResponse>();
let accepting = true;
let metrics: DaemonMetrics = NOOP_METRICS;

function activePublisherCount(): number {
  let count = 0;
  for (const record of pending.values()) {
    if (record.publisherActive) count += 1;
  }
  return count;
}

function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function bearerToken(header: unknown): string | undefined {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined;
  const value = header.slice('Bearer '.length);
  return value && !/\s/.test(value) ? value : undefined;
}

function sameToken(expected: Buffer, supplied: string): boolean {
  const actual = tokenHash(supplied);
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

function failure(code: string, message: string, details?: unknown): ExecutorCommandResult {
  return {
    success: false,
    error: { code, message, ...(details === undefined ? {} : { details }) },
  };
}

function settle(
  record: PendingResponse,
  result: ExecutorCommandResult,
  options: { failed: boolean; closePublisher?: boolean }
): boolean {
  if (record.settled) return false;
  record.settled = true;
  clearTimeout(record.timer);
  pending.delete(record.requestId);
  const failureClass = result.success ? 'none' : options.failed ? 'transport' : 'executor';
  metrics.increment('executor.responses', 1, {
    outcome: result.success ? 'success' : 'failure',
    failure_class: failureClass,
  });
  metrics.timing('executor.response_duration_ms', Date.now() - record.createdAt, {
    outcome: result.success ? 'success' : 'failure',
  });
  metrics.gauge('executor.responses_active', pending.size);
  metrics.gauge('executor.response_publishers_active', activePublisherCount());
  if (options.failed) {
    try {
      record.failureCleanup?.(result);
    } catch {
      // Cleanup is best effort. The terminal failure remains authoritative.
    }
  }
  record.resolve(result);
  if (options.closePublisher) record.closePublisher?.();
  return true;
}

export function configureExecutorResponseChannel(
  config: ExecutorResponseChannelRuntimeConfig
): void {
  if (pending.size > 0) {
    throw new Error('Cannot reconfigure executor responses while requests are active');
  }
  const origin = new URL(config.originUrl);
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
    throw new Error('Executor response origin must use HTTP(S)');
  }
  runtimeConfig = { ...config, originUrl: origin.origin };
  accepting = true;
  metrics.gauge('executor.responses_active', pending.size);
  metrics.gauge('executor.response_publishers_active', activePublisherCount());
}

export function reserveExecutorResponse(input: {
  tenantId?: string;
  userId?: string;
  command: string;
  branchId?: string;
  sessionId?: string;
  timeoutMs: number;
  timeoutResult: ExecutorCommandResult;
  profile?: ExecutorResponseDescriptor['profile'];
  onEvent?: (event: unknown) => void;
  /**
   * Reachable origin for THIS reservation's callback. Off-host (templated)
   * executors must be given a per-replica-addressable origin. Local subprocess
   * callers omit this and inherit the loopback origin, which always reaches the
   * replica holding the reservation.
   */
  originUrl?: string;
}): ExecutorResponseReservation {
  if (!accepting) {
    metrics.increment('executor.response_rejections', 1, { reason: 'draining' });
    throw new ExecutorResponseAdmissionError(
      failure('EXECUTOR_RESPONSE_DRAINING', 'Executor response requests are draining')
    );
  }
  if (pending.size >= runtimeConfig.maxActiveRequests) {
    metrics.increment('executor.response_rejections', 1, { reason: 'capacity' });
    throw new ExecutorResponseAdmissionError(
      failure('EXECUTOR_RESPONSE_BUSY', 'Executor response capacity is full')
    );
  }

  const requestId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const createdAt = Date.now();
  const deadlineAt = createdAt + input.timeoutMs;
  let resolve!: (result: ExecutorCommandResult) => void;
  const result = new Promise<ExecutorCommandResult>((done) => {
    resolve = done;
  });
  const record: PendingResponse = {
    requestId,
    tokenHash: tokenHash(token),
    tenantId: input.tenantId,
    userId: input.userId,
    command: input.command,
    branchId: input.branchId,
    sessionId: input.sessionId,
    deadlineAt,
    createdAt,
    maxResponseBytes: runtimeConfig.maxResponseBytes,
    profile: input.profile ?? 'terminal',
    nextSeq: 0,
    eventCount: 0,
    publisherActive: false,
    settled: false,
    resolve,
    onEvent: input.onEvent,
    timer: undefined as unknown as ReturnType<typeof setTimeout>,
  };
  record.timer = setTimeout(() => {
    settle(record, input.timeoutResult, { failed: true, closePublisher: true });
  }, input.timeoutMs);
  pending.set(requestId, record);
  metrics.increment('executor.response_requests');
  metrics.gauge('executor.responses_active', pending.size);

  const url = new URL(
    `${RESPONSE_PATH}/${requestId}`,
    input.originUrl ?? runtimeConfig.originUrl
  ).toString();
  return {
    descriptor: {
      protocol: EXECUTOR_RESPONSE_PROTOCOL,
      profile: record.profile,
      requestId,
      url,
      token,
      deadlineAt: new Date(deadlineAt).toISOString(),
      maxResponseBytes: runtimeConfig.maxResponseBytes,
    },
    result,
    fail: (terminal) => settle(record, terminal, { failed: true, closePublisher: true }),
    setFailureCleanup(cleanup) {
      if (record.settled) return;
      record.failureCleanup = cleanup;
    },
  };
}

function processFrame(record: PendingResponse, line: string): ExecutorCommandResult | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error('Executor response contains invalid JSON');
  }
  const frame = ExecutorResponseFrameSchema.safeParse(parsed);
  if (
    !frame.success ||
    frame.data.requestId !== record.requestId ||
    frame.data.seq !== record.nextSeq
  ) {
    throw new Error('Executor response frame is invalid or out of sequence');
  }
  record.nextSeq += 1;
  if (frame.data.type === 'event') {
    if (
      record.profile !== 'events' ||
      record.eventCount >= EXECUTOR_RESPONSE_MAX_EVENTS ||
      Buffer.byteLength(line) > EXECUTOR_RESPONSE_MAX_EVENT_BYTES
    ) {
      throw new Error('Executor response event is not allowed or exceeds its bound');
    }
    record.eventCount += 1;
    record.onEvent?.({ ...frame.data.data, type: frame.data.name });
    return undefined;
  }
  return frame.data.result;
}

/** Register the raw NDJSON receiver. Generic JSON body parsing must not own it. */
export function registerExecutorResponseRoutes(app: object): void {
  metrics = getDaemonMetrics(app);
  metrics.gauge('executor.responses_active', pending.size);
  metrics.gauge('executor.response_publishers_active', activePublisherCount());
  const routeApp = app as unknown as {
    post(path: string, handler: (req: Request, res: Response) => void): unknown;
  };
  routeApp.post(`${RESPONSE_PATH}/:requestId`, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const record = pending.get(String(req.params.requestId));
    const token = bearerToken(req.headers.authorization);
    if (
      !record ||
      !token ||
      !sameToken(record.tokenHash, token) ||
      record.deadlineAt <= Date.now()
    ) {
      metrics.increment('executor.response_rejections', 1, { reason: 'capability' });
      res.status(404).end();
      return;
    }
    if (record.publisherActive) {
      metrics.increment('executor.response_rejections', 1, { reason: 'duplicate_publisher' });
      res.status(409).end();
      return;
    }

    // Settle the waiter with a transport failure and end the pre-stream request.
    // Used only before a publisher is attached, so there is nothing to close.
    const reject = (status: number, result: ExecutorCommandResult): void => {
      settle(record, result, { failed: true });
      res.status(status).end();
    };

    if (
      String(req.headers['content-type'] ?? '')
        .split(';', 1)[0]
        ?.trim()
        .toLowerCase() !== EXECUTOR_RESPONSE_CONTENT_TYPE ||
      req.headers[EXECUTOR_RESPONSE_PROTOCOL_HEADER] !== EXECUTOR_RESPONSE_PROTOCOL ||
      (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')
    ) {
      reject(
        400,
        failure('EXECUTOR_RESPONSE_INVALID', 'Executor response content type is invalid')
      );
      return;
    }

    const declaredLength = req.headers['content-length'];
    if (declaredLength !== undefined) {
      const length = Number(declaredLength);
      if (
        typeof declaredLength !== 'string' ||
        !/^\d+$/.test(declaredLength) ||
        !Number.isSafeInteger(length)
      ) {
        reject(400, failure('EXECUTOR_RESPONSE_INVALID', 'Executor response length is invalid'));
        return;
      }
      if (length > record.maxResponseBytes) {
        reject(
          413,
          failure(
            EXECUTOR_RESPONSE_TOO_LARGE,
            'Executor response exceeds the configured size limit',
            {
              maxResponseBytes: record.maxResponseBytes,
            }
          )
        );
        return;
      }
    }

    record.publisherActive = true;
    metrics.gauge('executor.response_publishers_active', activePublisherCount());
    let received = 0;
    let done = false;
    let frameChunks: Buffer[] = [];
    let frameBytes = 0;
    let terminalCandidate: ExecutorCommandResult | undefined;
    const decoder = new TextDecoder('utf-8', { fatal: true });

    const failAuthenticated = (status: number, result: ExecutorCommandResult) => {
      if (done) return;
      done = true;
      settle(record, result, { failed: true });
      if (!res.headersSent) res.status(status).end();
      else res.end();
    };

    record.closePublisher = () => {
      if (done) return;
      done = true;
      if (!res.headersSent) res.status(404).end();
      req.destroy();
    };

    const acceptFrame = () => {
      const bytes =
        frameChunks.length === 1 ? frameChunks[0]! : Buffer.concat(frameChunks, frameBytes);
      frameChunks = [];
      frameBytes = 0;
      const content = bytes.at(-1) === 0x0d ? bytes.subarray(0, bytes.length - 1) : bytes;
      const line = decoder.decode(content);
      if (!line) throw new Error('Executor response contains an empty frame');
      const terminal = processFrame(record, line);
      if (terminal) terminalCandidate = terminal;
    };

    req.on('data', (chunk: Buffer) => {
      if (done) return;
      received += chunk.byteLength;
      if (received > record.maxResponseBytes) {
        failAuthenticated(
          413,
          failure(
            EXECUTOR_RESPONSE_TOO_LARGE,
            'Executor response exceeds the configured size limit',
            { maxResponseBytes: record.maxResponseBytes }
          )
        );
        req.resume();
        return;
      }
      try {
        let offset = 0;
        while (offset < chunk.length) {
          if (terminalCandidate) {
            throw new Error('Executor response contains bytes after final');
          }
          const newline = chunk.indexOf(0x0a, offset);
          if (newline === -1) {
            const remainder = chunk.subarray(offset);
            frameChunks.push(remainder);
            frameBytes += remainder.byteLength;
            break;
          }
          const part = chunk.subarray(offset, newline);
          frameChunks.push(part);
          frameBytes += part.byteLength;
          acceptFrame();
          offset = newline + 1;
        }
      } catch {
        failAuthenticated(
          400,
          failure('EXECUTOR_RESPONSE_INVALID', 'Executor response framing is invalid')
        );
      }
    });

    req.on('end', () => {
      if (done) return;
      try {
        if (frameBytes > 0) {
          if (terminalCandidate) throw new Error('Executor response contains bytes after final');
          acceptFrame();
        }
        if (!terminalCandidate) {
          failAuthenticated(
            400,
            failure('EXECUTOR_RESPONSE_MISSING', 'Executor response ended without a final frame')
          );
          return;
        }
        done = true;
        settle(record, terminalCandidate, { failed: false });
        res.status(204).end();
      } catch {
        failAuthenticated(
          400,
          failure('EXECUTOR_RESPONSE_INVALID', 'Executor response framing is invalid')
        );
      }
    });
    req.on('aborted', () => {
      failAuthenticated(
        400,
        failure('EXECUTOR_RESPONSE_DISCONNECTED', 'Executor response disconnected before final')
      );
    });
    req.on('error', () => {
      failAuthenticated(
        400,
        failure('EXECUTOR_RESPONSE_DISCONNECTED', 'Executor response transport failed')
      );
    });
    res.on('close', () => {
      if (!done && !res.writableFinished) {
        failAuthenticated(
          400,
          failure('EXECUTOR_RESPONSE_DISCONNECTED', 'Executor response connection closed')
        );
      }
    });
  });
}

/** Test-only observability without exposing capabilities or response bytes. */
export function activeExecutorResponseCount(): number {
  return pending.size;
}

/** Test-only publisher gauge without exposing capabilities or response bytes. */
export function activeExecutorResponsePublisherCount(): number {
  return activePublisherCount();
}

export function beginExecutorResponseDrain(): void {
  accepting = false;
  for (const record of [...pending.values()]) {
    settle(
      record,
      failure(
        'EXECUTOR_RESPONSE_DAEMON_STOPPING',
        'Daemon stopped while awaiting executor response'
      ),
      { failed: true, closePublisher: true }
    );
  }
}

/**
 * In-process protocol injection for spawn-host unit tests. Route tests exercise
 * authentication, byte limits, and framing separately through HTTP.
 */
export function submitExecutorResponseForTesting(input: {
  requestId: string;
  token: string;
  frames: unknown[];
}): boolean {
  const record = pending.get(input.requestId);
  if (!record || !sameToken(record.tokenHash, input.token)) return false;
  for (const raw of input.frames) {
    let terminal: ExecutorCommandResult | undefined;
    try {
      terminal = processFrame(record, JSON.stringify(raw));
    } catch {
      return false;
    }
    if (terminal) return settle(record, terminal, { failed: false });
  }
  return true;
}
