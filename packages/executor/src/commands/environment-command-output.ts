import { ENVIRONMENT } from '@agor/core/config';
import {
  ENVIRONMENT_LIFECYCLE_RESULT_MAX_BYTES,
  ENVIRONMENT_LIFECYCLE_RESULT_PREFIX,
  ENVIRONMENT_LIFECYCLE_RESULT_VERSION,
  type EnvironmentLifecycleResult,
  lifecycleResultTemplateFacts,
  validateEnvironmentLifecycleResult,
} from '@agor/core/environment/lifecycle-result';

const LEGACY_FACT_KEYS = new Set(['url', 'url_manager', 'health', 'name']);
const MAX_CONTROL_LINE_BYTES =
  ENVIRONMENT_LIFECYCLE_RESULT_PREFIX.length + ENVIRONMENT_LIFECYCLE_RESULT_MAX_BYTES;

interface OutputSink {
  write(value: string): unknown;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

class BoundedOutputTail {
  private value = '';
  private byteTruncated = false;

  append(text: string): void {
    if (!text) return;
    this.value += text;
    const encoded = Buffer.from(this.value, 'utf8');
    if (encoded.byteLength > ENVIRONMENT.LOGS_MAX_BYTES) {
      this.value = encoded
        .subarray(encoded.byteLength - ENVIRONMENT.LOGS_MAX_BYTES)
        .toString('utf8');
      this.byteTruncated = true;
    }
  }

  render(): string | undefined {
    const lines = this.value.split('\n');
    const lineTruncated = lines.length > ENVIRONMENT.LOGS_MAX_LINES;
    const visible = lineTruncated
      ? lines.slice(-ENVIRONMENT.LOGS_MAX_LINES).join('\n')
      : this.value;
    const marker =
      this.byteTruncated || lineTruncated ? '... (environment output truncated)\n' : '';
    const rendered = `${marker}${visible}`.trim();
    return rendered || undefined;
  }
}

/**
 * Streaming stdout/stderr capture for lifecycle commands.
 *
 * Only stdout is a control channel. Result records are suppressed before
 * streaming and persistence, while stderr is always ordinary diagnostic text.
 * The retained visible tail is bounded even when a command writes forever
 * without newlines.
 */
export class EnvironmentCommandOutputCapture {
  private readonly output = new BoundedOutputTail();
  private stdoutPending = '';
  private stdoutVisibleContinuation = false;
  private stdoutSuppressedContinuation = false;
  private resultPayloads: string[] = [];
  private legacyFacts = new Map<string, string>();
  private protocolError?: Error;
  private finished = false;

  constructor(
    private readonly options: {
      parseLifecycleResult: boolean;
      stdout?: OutputSink;
      stderr?: OutputSink;
    }
  ) {}

  writeStdout(text: string): void {
    if (!this.options.parseLifecycleResult) {
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
        if (this.looksLikeControlLine(this.stdoutPending)) {
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

  writeStderr(text: string): void {
    // Stderr is intentionally never parsed as a control channel.
    this.emitVisible(text, this.options.stderr);
  }

  finish(): {
    output?: string;
    lifecycleResult?: EnvironmentLifecycleResult;
    facts: Record<string, string>;
  } {
    if (this.finished) throw new Error('environment command output was already finalized');
    this.finished = true;
    if (this.stdoutPending) this.processStdoutLine(this.stdoutPending, false);
    if (this.protocolError) throw this.protocolError;
    if (this.resultPayloads.length > 1) {
      throw new Error('environment command emitted more than one result line');
    }
    if (this.resultPayloads.length > 0 && this.legacyFacts.size > 0) {
      throw new Error('environment command mixed typed and legacy result protocols');
    }
    let lifecycleResult: EnvironmentLifecycleResult | undefined;
    if (this.resultPayloads.length === 1) {
      const encoded = this.resultPayloads[0];
      if (Buffer.byteLength(encoded, 'utf8') > ENVIRONMENT_LIFECYCLE_RESULT_MAX_BYTES) {
        throw new Error('environment command result exceeds the size limit');
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(encoded);
      } catch {
        throw new Error('environment command emitted invalid result JSON');
      }
      lifecycleResult = validateEnvironmentLifecycleResult(decoded);
    } else if (this.legacyFacts.size > 0) {
      lifecycleResult = this.convertLegacyFacts();
    }

    return {
      output: this.output.render(),
      lifecycleResult,
      facts: lifecycleResultTemplateFacts(lifecycleResult),
    };
  }

  visibleOutput(): string | undefined {
    return this.output.render();
  }

  private emitVisible(text: string, sink?: OutputSink): void {
    sink?.write(text);
    this.output.append(text);
  }

  private looksLikeControlLine(line: string): boolean {
    return line.startsWith(ENVIRONMENT_LIFECYCLE_RESULT_PREFIX) || /^\s*AGOR_FACT\b/.test(line);
  }

  private processStdoutLine(line: string, newline: boolean): void {
    if (line.startsWith(ENVIRONMENT_LIFECYCLE_RESULT_PREFIX)) {
      this.resultPayloads.push(line.slice(ENVIRONMENT_LIFECYCLE_RESULT_PREFIX.length));
      return;
    }

    const legacy = line.match(/^\s*AGOR_FACT\s+([A-Za-z0-9_]+)=(.*)$/);
    if (legacy) {
      const [, key, rawValue] = legacy;
      if (!LEGACY_FACT_KEYS.has(key)) {
        this.protocolError ??= new Error(
          `environment command emitted unsupported legacy fact ${key}`
        );
        return;
      }
      if (this.legacyFacts.has(key)) {
        this.protocolError ??= new Error(
          `environment command emitted duplicate legacy fact ${key}`
        );
        return;
      }
      const value = rawValue.trim();
      const maxLength = key === 'name' ? 256 : 2_048;
      if (!value || value.length > maxLength || hasControlCharacter(value)) {
        this.protocolError ??= new Error(`environment command legacy fact ${key} is invalid`);
        return;
      }
      this.legacyFacts.set(key, value);
      return;
    }
    if (/^\s*AGOR_FACT\b/.test(line)) {
      this.protocolError ??= new Error('environment command emitted malformed legacy fact');
      return;
    }
    this.emitVisible(`${line}${newline ? '\n' : ''}`, this.options.stdout);
  }

  private convertLegacyFacts(): EnvironmentLifecycleResult {
    const accessUrls = [
      ...(this.legacyFacts.has('url')
        ? [{ name: 'App', url: this.legacyFacts.get('url') as string }]
        : []),
      ...(this.legacyFacts.has('url_manager')
        ? [{ name: 'Manager', url: this.legacyFacts.get('url_manager') as string }]
        : []),
    ];
    return validateEnvironmentLifecycleResult({
      version: ENVIRONMENT_LIFECYCLE_RESULT_VERSION,
      ...(accessUrls.length > 0 ? { access_urls: accessUrls } : {}),
      ...(this.legacyFacts.has('health') ? { health_url: this.legacyFacts.get('health') } : {}),
      ...(this.legacyFacts.has('name') ? { resource: { name: this.legacyFacts.get('name') } } : {}),
    });
  }
}
