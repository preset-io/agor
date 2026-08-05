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

/** Collapses the fleet-wide burst produced when Slack clients miss pong deadlines together. */
class SlackHeartbeatWarningAggregator {
  private warningCount = 0;
  private warningCountCapped = false;
  private readonly clientTokens = new Set<object>();
  private clientCountCapped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  record(clientToken: object): void {
    if (this.warningCount < MAX_WARNINGS_PER_WINDOW) this.warningCount++;
    else this.warningCountCapped = true;

    if (!this.clientTokens.has(clientToken)) {
      if (this.clientTokens.size < MAX_CLIENTS_PER_WINDOW) this.clientTokens.add(clientToken);
      else this.clientCountCapped = true;
    }

    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), HEARTBEAT_WARNING_WINDOW_MS);
    this.timer.unref?.();
  }

  private flush(): void {
    const warningCount = `${this.warningCount}${this.warningCountCapped ? '+' : ''}`;
    const clientCount = `${this.clientTokens.size}${this.clientCountCapped ? '+' : ''}`;

    this.timer = undefined;
    this.warningCount = 0;
    this.warningCountCapped = false;
    this.clientTokens.clear();
    this.clientCountCapped = false;

    console.warn(
      `[slack.socket_mode] heartbeat_timeout category=client_pong_timeout clients=${clientCount} warnings=${warningCount} window_ms=${HEARTBEAT_WARNING_WINDOW_MS}`
    );
  }
}

const sharedHeartbeatWarnings = new SlackHeartbeatWarningAggregator();

class SlackSdkLogger implements Logger {
  private level = LogLevel.INFO;
  private readonly clientToken = {};

  debug(..._messages: unknown[]): void {}

  info(..._messages: unknown[]): void {}

  warn(...messages: unknown[]): void {
    if (!this.shouldLog(LogLevel.WARN)) return;
    if (typeof messages[0] === 'string' && CLIENT_PONG_TIMEOUT_RE.test(messages[0])) {
      sharedHeartbeatWarnings.record(this.clientToken);
      return;
    }
    console.warn('[slack.socket_mode] sdk_warning category=sdk_warning');
  }

  error(..._messages: unknown[]): void {
    if (!this.shouldLog(LogLevel.ERROR)) return;
    console.error('[slack.socket_mode] sdk_error category=sdk_error');
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  setName(_name: string): void {}

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level];
  }
}

/** Create one safe logger for a Slack Socket Mode client. */
export function createSlackSdkLogger(): Logger {
  return new SlackSdkLogger();
}
