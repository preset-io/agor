import {
  type EnvironmentLifecycleResult,
  validateEnvironmentLifecycleResult,
} from '@agor/core/environment/lifecycle-result';
import { EnvironmentOutput } from './environment-shell.js';

export const ENVIRONMENT_RESULT_PREFIX = 'AGOR_ENVIRONMENT_RESULT=';
const MAX_ENVIRONMENT_RESULT_BYTES = 8 * 1024;
const MAX_CONTROL_LINE_BYTES = ENVIRONMENT_RESULT_PREFIX.length + MAX_ENVIRONMENT_RESULT_BYTES;

interface OutputSink {
  write(value: string): unknown;
}

/**
 * Streaming capture which treats stdout alone as a control channel. Result
 * records are suppressed from diagnostics even when split across chunks;
 * stderr is always ordinary output.
 */
export class EnvironmentCommandOutputCapture {
  private readonly visible = new EnvironmentOutput();
  private stdoutPending = '';
  private stdoutVisibleContinuation = false;
  private stdoutSuppressedContinuation = false;
  private readonly resultPayloads: string[] = [];
  private protocolError?: Error;
  private finished = false;

  constructor(
    private readonly options: {
      parseEnvironmentResult: boolean;
      stdout?: OutputSink;
      stderr?: OutputSink;
    }
  ) {}

  get truncated(): boolean {
    return this.visible.truncated;
  }

  text(): string {
    return this.visible.text();
  }

  writeStdout(chunk: Buffer | string): void {
    const text = chunk.toString();
    if (!this.options.parseEnvironmentResult) {
      this.emitVisible(text, this.options.stdout);
      return;
    }

    let remaining = text;
    while (remaining) {
      if (this.stdoutVisibleContinuation) {
        const newline = remaining.indexOf('\n');
        if (newline < 0) {
          this.emitVisible(remaining, this.options.stdout);
          return;
        }
        this.emitVisible(remaining.slice(0, newline + 1), this.options.stdout);
        remaining = remaining.slice(newline + 1);
        this.stdoutVisibleContinuation = false;
        continue;
      }
      if (this.stdoutSuppressedContinuation) {
        const newline = remaining.indexOf('\n');
        if (newline < 0) return;
        remaining = remaining.slice(newline + 1);
        this.stdoutSuppressedContinuation = false;
        continue;
      }

      this.stdoutPending += remaining;
      remaining = '';
      let newline = this.stdoutPending.indexOf('\n');
      while (newline >= 0) {
        const line = this.stdoutPending.slice(0, newline);
        this.stdoutPending = this.stdoutPending.slice(newline + 1);
        this.processStdoutLine(line, true);
        newline = this.stdoutPending.indexOf('\n');
      }

      if (Buffer.byteLength(this.stdoutPending, 'utf8') > MAX_CONTROL_LINE_BYTES) {
        if (this.stdoutPending.startsWith(ENVIRONMENT_RESULT_PREFIX)) {
          this.protocolError ??= new Error('environment command result exceeds the size limit');
          this.stdoutPending = '';
          this.stdoutSuppressedContinuation = true;
        } else {
          this.emitVisible(this.stdoutPending, this.options.stdout);
          this.stdoutPending = '';
          this.stdoutVisibleContinuation = true;
        }
      }
    }
  }

  writeStderr(chunk: Buffer | string): void {
    this.emitVisible(chunk.toString(), this.options.stderr);
  }

  finish(): { output: string; environmentResult?: EnvironmentLifecycleResult } {
    if (this.finished) throw new Error('environment command output was already finalized');
    this.finished = true;
    if (this.stdoutPending) this.processStdoutLine(this.stdoutPending, false);
    if (this.protocolError) throw this.protocolError;
    if (this.resultPayloads.length > 1) {
      throw new Error('environment command emitted more than one result line');
    }
    if (this.resultPayloads.length === 0) return { output: this.text() };

    const encoded = this.resultPayloads[0]!;
    let decoded: unknown;
    try {
      decoded = JSON.parse(encoded);
    } catch {
      throw new Error('environment command emitted invalid result JSON');
    }
    return {
      output: this.text(),
      environmentResult: validateEnvironmentLifecycleResult(decoded),
    };
  }

  private processStdoutLine(line: string, newline: boolean): void {
    if (line.startsWith(ENVIRONMENT_RESULT_PREFIX)) {
      this.resultPayloads.push(line.slice(ENVIRONMENT_RESULT_PREFIX.length));
      return;
    }
    this.emitVisible(`${line}${newline ? '\n' : ''}`, this.options.stdout);
  }

  private emitVisible(text: string, sink?: OutputSink): void {
    sink?.write(text);
    this.visible.append(Buffer.from(text));
  }
}
