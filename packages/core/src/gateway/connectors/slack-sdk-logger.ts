import { type Logger, LogLevel } from '@slack/socket-mode';

const CLIENT_PONG_TIMEOUT_RE =
  /^A pong wasn't received from the server before the timeout of \d+ms!$/;
const HEARTBEAT_WARNING_WINDOW_MS = 10_000;
const MAX_WARNINGS_PER_WINDOW = 1_000;
const MAX_CLIENTS_PER_WINDOW = 100;

export type SlackSocketLifecycleState = 'starting' | 'active' | 'stopping' | 'stopped';

export interface SlackSdkLoggerController {
  logger: Logger;
  setLifecycleState(state: SlackSocketLifecycleState): void;
}

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
  private lifecycleState: SlackSocketLifecycleState = 'starting';

  setLifecycleState(state: SlackSocketLifecycleState): void {
    this.lifecycleState = state;
  }

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

  error(...messages: unknown[]): void {
    if (!this.shouldLog(LogLevel.ERROR)) return;
    const category = classifySlackSdkError(messages[0]);
    const lifecycle = this.lifecycleState;
    const output = `[slack.socket_mode] sdk_error category=${category} lifecycle=${lifecycle}`;

    // The SDK can report a transport attempt while start() is still deciding
    // whether to reconnect or reject. The listener owner records the eventual
    // started/retry/blocked outcome, so this is degraded startup context, not
    // yet an outage. Once active, the same SDK error is an outage signal.
    if (lifecycle === 'starting' || lifecycle === 'stopping' || lifecycle === 'stopped') {
      console.warn(output);
    } else {
      console.error(output);
    }
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

function classifySlackSdkError(value: unknown): string {
  const code =
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof (value as { code?: unknown }).code === 'string'
      ? (value as { code: string }).code.toLowerCase()
      : undefined;
  if (
    code &&
    ['invalid_auth', 'not_authed', 'token_revoked', 'account_inactive', 'token_expired'].includes(
      code
    )
  ) {
    return 'authentication';
  }
  if (code && ['ratelimited', 'rate_limited'].includes(code)) return 'rate_limited';
  if (code && ['slack_websocket_error', 'request_error'].includes(code)) return 'transport';

  const message = typeof value === 'string' ? value : value instanceof Error ? value.message : '';
  if (/invalid_auth|not_authed|token_revoked|account_inactive/i.test(message)) {
    return 'authentication';
  }
  if (/rate.?limit|too many requests|status(?: code)? 429/i.test(message)) {
    return 'rate_limited';
  }
  if (/websocket|socket|wss|connection|disconnect|connect|network|timeout/i.test(message)) {
    return 'transport';
  }
  return 'unclassified';
}

/** Create one safe logger for a Slack Socket Mode client. */
export function createSlackSdkLogger(): Logger {
  return new SlackSdkLogger();
}

/** Create a safe logger plus the lifecycle correlation controlled by its owner. */
export function createSlackSdkLoggerController(): SlackSdkLoggerController {
  const logger = new SlackSdkLogger();
  return {
    logger,
    setLifecycleState: (state) => logger.setLifecycleState(state),
  };
}
