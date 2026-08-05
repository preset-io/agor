import { type Logger, LogLevel } from '@slack/socket-mode';

const CLIENT_PONG_TIMEOUT_RE =
  /^A pong wasn't received from the server before the timeout of \d+ms!$/;
const DEFAULT_HEARTBEAT_WARNING_WINDOW_MS = 10_000;

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  [LogLevel.DEBUG]: 100,
  [LogLevel.INFO]: 200,
  [LogLevel.WARN]: 300,
  [LogLevel.ERROR]: 400,
};

export interface SlackHeartbeatWarningAggregatorOptions {
  windowMs?: number;
  emitWarning?: (message: string) => void;
}

/**
 * Collapses the fleet-wide warning burst produced when every Slack client
 * misses its pong deadline in the same event-loop tick.
 */
export class SlackHeartbeatWarningAggregator {
  private readonly windowMs: number;
  private readonly emitWarning: (message: string) => void;
  private warningCount = 0;
  private readonly clients = new Set<object>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: SlackHeartbeatWarningAggregatorOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_HEARTBEAT_WARNING_WINDOW_MS;
    this.emitWarning = options.emitWarning ?? ((message) => console.warn(message));
  }

  record(client: object): void {
    this.warningCount++;
    this.clients.add(client);
    if (this.timer) return;

    this.timer = setTimeout(() => this.flush(), this.windowMs);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.reset();
  }

  private flush(): void {
    const warningCount = this.warningCount;
    const clientCount = this.clients.size;
    this.reset();
    if (warningCount === 0) return;

    this.emitWarning(
      `[slack.socket_mode] heartbeat_timeout category=client_pong_timeout clients=${clientCount} warnings=${warningCount} window_ms=${this.windowMs}`
    );
  }

  private reset(): void {
    this.timer = undefined;
    this.warningCount = 0;
    this.clients.clear();
  }
}

const sharedHeartbeatWarnings = new SlackHeartbeatWarningAggregator();

class SlackSdkLogger implements Logger {
  private level = LogLevel.INFO;
  private name = '';

  constructor(private readonly heartbeatWarnings: SlackHeartbeatWarningAggregator) {}

  debug(...messages: unknown[]): void {
    this.write(LogLevel.DEBUG, messages);
  }

  info(...messages: unknown[]): void {
    this.write(LogLevel.INFO, messages);
  }

  warn(...messages: unknown[]): void {
    if (!this.shouldLog(LogLevel.WARN)) return;
    if (typeof messages[0] === 'string' && CLIENT_PONG_TIMEOUT_RE.test(messages[0])) {
      this.heartbeatWarnings.record(this);
      return;
    }
    this.write(LogLevel.WARN, messages);
  }

  error(...messages: unknown[]): void {
    this.write(LogLevel.ERROR, messages);
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  setName(name: string): void {
    this.name = name;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level];
  }

  private write(level: LogLevel, messages: unknown[]): void {
    if (!this.shouldLog(level)) return;
    const safeMessages = messages.map((message) => {
      if (message instanceof Error) return '[sdk_error]';
      if (typeof message === 'object' && message !== null) return '[sdk_object]';
      return message;
    });
    const output = [`[${level.toUpperCase()}] `, this.name, ...safeMessages];
    if (level === LogLevel.DEBUG) console.debug(...output);
    else if (level === LogLevel.INFO) console.info(...output);
    else if (level === LogLevel.WARN) console.warn(...output);
    else console.error(...output);
  }
}

export function createSlackSdkLogger(
  heartbeatWarnings: SlackHeartbeatWarningAggregator = sharedHeartbeatWarnings
): Logger {
  return new SlackSdkLogger(heartbeatWarnings);
}
