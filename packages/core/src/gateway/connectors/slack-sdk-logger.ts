import { type Logger, LogLevel } from '@slack/socket-mode';

const CLIENT_PONG_TIMEOUT_RE =
  /^A pong wasn't received from the server before the timeout of \d+ms!$/;
const HEARTBEAT_WARNING_WINDOW_MS = 10_000;
const MAX_WARNINGS_PER_WINDOW = 1_000;
const MAX_CLIENTS_PER_WINDOW = 100;

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  [LogLevel.DEBUG]: 100,
  [LogLevel.INFO]: 200,
  [LogLevel.WARN]: 300,
  [LogLevel.ERROR]: 400,
};

const SAFE_CATEGORY_BY_LEVEL: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'sdk_debug',
  [LogLevel.INFO]: 'sdk_info',
  [LogLevel.WARN]: 'sdk_warning',
  [LogLevel.ERROR]: 'sdk_error',
};

/** Collapses the fleet-wide burst produced when Slack clients miss pong deadlines together. */
class SlackHeartbeatWarningAggregator {
  private activeClients = 0;
  private warningCount = 0;
  private warningCountCapped = false;
  private readonly clients = new Set<object>();
  private clientCountCapped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  acquire(): void {
    this.activeClients++;
  }

  release(): void {
    if (this.activeClients === 0) return;
    this.activeClients--;
    if (this.activeClients === 0) this.reset();
  }

  record(client: object): void {
    if (this.warningCount < MAX_WARNINGS_PER_WINDOW) this.warningCount++;
    else this.warningCountCapped = true;

    if (!this.clients.has(client)) {
      if (this.clients.size < MAX_CLIENTS_PER_WINDOW) this.clients.add(client);
      else this.clientCountCapped = true;
    }

    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), HEARTBEAT_WARNING_WINDOW_MS);
    this.timer.unref?.();
  }

  private flush(): void {
    const warningCount = this.cappedCount(this.warningCount, this.warningCountCapped);
    const clientCount = this.cappedCount(this.clients.size, this.clientCountCapped);
    const hasWarnings = this.warningCount > 0;
    this.reset();
    if (!hasWarnings) return;

    console.warn(
      `[slack.socket_mode] heartbeat_timeout category=client_pong_timeout clients=${clientCount} warnings=${warningCount} window_ms=${HEARTBEAT_WARNING_WINDOW_MS}`
    );
  }

  private cappedCount(count: number, capped: boolean): string {
    return `${count}${capped ? '+' : ''}`;
  }

  private reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.warningCount = 0;
    this.warningCountCapped = false;
    this.clients.clear();
    this.clientCountCapped = false;
  }
}

const sharedHeartbeatWarnings = new SlackHeartbeatWarningAggregator();

class SlackSdkLogger implements Logger {
  private level = LogLevel.INFO;
  private retired = false;

  constructor(private readonly heartbeatWarnings: SlackHeartbeatWarningAggregator) {}

  debug(..._messages: unknown[]): void {
    this.write(LogLevel.DEBUG);
  }

  info(..._messages: unknown[]): void {
    this.write(LogLevel.INFO);
  }

  warn(...messages: unknown[]): void {
    if (this.retired) return;
    if (!this.shouldLog(LogLevel.WARN)) return;
    if (typeof messages[0] === 'string' && CLIENT_PONG_TIMEOUT_RE.test(messages[0])) {
      this.heartbeatWarnings.record(this);
      return;
    }
    this.write(LogLevel.WARN);
  }

  error(..._messages: unknown[]): void {
    this.write(LogLevel.ERROR);
  }

  setLevel(level: LogLevel): void {
    if (this.retired) return;
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  setName(_name: string): void {}

  retire(): void {
    this.retired = true;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level];
  }

  private write(level: LogLevel): void {
    if (this.retired) return;
    if (!this.shouldLog(level)) return;
    const category = SAFE_CATEGORY_BY_LEVEL[level];
    const output = `[slack.socket_mode] ${category} category=${category}`;
    if (level === LogLevel.DEBUG) console.debug(output);
    else if (level === LogLevel.INFO) console.info(output);
    else if (level === LogLevel.WARN) console.warn(output);
    else console.error(output);
  }
}

/** Acquire one production Slack SDK logger and its idempotent lifecycle release. */
export function acquireSlackSdkLogger(): { logger: Logger; release: () => void } {
  sharedHeartbeatWarnings.acquire();
  const logger = new SlackSdkLogger(sharedHeartbeatWarnings);
  let active = true;
  return {
    logger,
    release: () => {
      if (!active) return;
      active = false;
      logger.retire();
      sharedHeartbeatWarnings.release();
    },
  };
}
