import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { hostname } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { EXECUTOR_SCRATCH_ROOT_ENV } from '@agor/core/config';
import { PROVIDER_CREDENTIAL_FIELDS } from '@agor/core/types';
import type * as SDK from '@google/gemini-cli-core';

export const GEMINI_KEY_MESSAGE =
  'Gemini needs an API key. Add one in Settings → Gemini (Google-account sign-in is not supported).';
export const GEMINI_HISTORY_NOTICE =
  'Earlier Gemini conversation could not be restored; continuing without it.';
/** Closed provider failure classes from geminiError; never provider text. */
type GeminiFailureCategory =
  | 'authentication'
  | 'model_unavailable'
  | 'quota'
  | 'busy'
  | 'provider_error'
  | 'network'
  | 'unknown';

interface GeminiFailureDiagnostic {
  category?: GeminiFailureCategory;
  httpStatus?: number;
  errorClass?: string;
}

const GEMINI_ERROR_CLASSES: ReadonlySet<string> = new Set([
  'ApiError',
  'TerminalQuotaError',
  'RetryableQuotaError',
  'UnauthorizedError',
  'ForbiddenError',
  'AccountSuspendedError',
  'FatalAuthenticationError',
  'ModelNotFoundError',
  'ValidationRequiredError',
]);

const GEMINI_AUTH_CLASSES: ReadonlySet<string> = new Set([
  'UnauthorizedError',
  'ForbiddenError',
  'AccountSuspendedError',
  'FatalAuthenticationError',
  'ValidationRequiredError',
]);

const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Logged category from structured signals only (status, allowlisted class,
 * string `code`), so two failures with the same shape always log the same line
 * whatever the provider prose says. Specific classes win over generic statuses.
 */
function geminiFailureCategory(
  httpStatus: number | undefined,
  errorClass: string | undefined,
  codes: unknown[]
): GeminiFailureCategory {
  if (errorClass && GEMINI_AUTH_CLASSES.has(errorClass)) return 'authentication';
  if (errorClass === 'ModelNotFoundError') return 'model_unavailable';
  if (errorClass === 'TerminalQuotaError') return 'quota';
  if (errorClass === 'RetryableQuotaError') return 'busy';
  if (httpStatus === 401 || httpStatus === 403) return 'authentication';
  if (httpStatus === 404) return 'model_unavailable';
  if (httpStatus === 429 || httpStatus === 503) return 'busy';
  if (httpStatus !== undefined && httpStatus >= 500) return 'provider_error';
  if (codes.some((code) => typeof code === 'string' && NETWORK_ERROR_CODES.has(code))) {
    return 'network';
  }
  return 'unknown';
}

export class GeminiIntegrationError extends Error {
  readonly category?: GeminiFailureCategory;
  readonly httpStatus?: number;
  readonly errorClass?: string;

  constructor(message: string, diagnostic: GeminiFailureDiagnostic = {}) {
    super(message);
    this.category = diagnostic.category;
    this.httpStatus = diagnostic.httpStatus;
    this.errorClass = diagnostic.errorClass;
  }
}

/**
 * One `[gemini.failure]` key=value line for a failed task. Provider-classified
 * failures carry their closed category; other fixed integration errors say
 * `integration`, and non-Gemini errors say `local`.
 */
export function geminiFailureLine(stage: string, error: unknown): string {
  const fields =
    error instanceof GeminiIntegrationError
      ? [
          `category=${error.category ?? 'integration'}`,
          ...(error.httpStatus !== undefined ? [`http_status=${error.httpStatus}`] : []),
          ...(error.errorClass ? [`error_class=${error.errorClass}`] : []),
        ]
      : ['category=local'];
  return `[gemini.failure] stage=${stage} ${fields.join(' ')}`;
}
export const GEMINI_RESET_HISTORY_FOR = 'AGOR_GEMINI_RESET_HISTORY_FOR';

/** Only fixed messages leave this boundary; never propagate provider bodies. */
export function geminiError(error: unknown, model: string): GeminiIntegrationError {
  if (error instanceof GeminiIntegrationError) return error;
  const value = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const nested =
    value.error && typeof value.error === 'object'
      ? (value.error as Record<string, unknown>)
      : value;
  const message = String(nested.message ?? '');
  const status = Number(nested.status ?? nested.code);
  const name = String(nested.name ?? '');
  const httpStatus =
    Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
  const errorClass = [nested.name, value.name].find(
    (candidate): candidate is string =>
      typeof candidate === 'string' && GEMINI_ERROR_CLASSES.has(candidate)
  );
  let safe = 'Gemini integration error.';
  if (
    (status === 400 && /API_KEY_INVALID|API key not valid/i.test(message)) ||
    status === 401 ||
    (status === 403 && !/terms.of.service|tos.violation/i.test(message)) ||
    /Account.*Error|AuthenticationError|UnauthorizedError|ValidationRequiredError/.test(name)
  ) {
    safe = 'Gemini rejected the API key. Check it in Settings → Gemini.';
  } else if (status === 404 || /model.*(?:not found|not available|not supported)/i.test(message)) {
    safe = `Model ${model} isn't available to this API key. Pick another Gemini model.`;
  } else if (
    name === 'TerminalQuotaError' ||
    (name !== 'RetryableQuotaError' &&
      status === 429 &&
      !/RetryInfo|retryDelay|per.minute|retry (?:in|after)/i.test(message))
  ) {
    safe = "This API key's plan or quota doesn't allow this request.";
  } else if (status === 429 || status === 503 || name === 'RetryableQuotaError') {
    safe = 'Gemini is busy or rate-limited. Try again shortly.';
  } else if (status >= 500 && status < 600) {
    safe = 'Gemini API error. Try again later.';
  } else if (/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|network/i.test(message)) {
    safe = 'Could not reach the Gemini API.';
  }
  const cause =
    value.cause && typeof value.cause === 'object' ? (value.cause as Record<string, unknown>) : {};
  const category = geminiFailureCategory(httpStatus, errorClass, [
    nested.code,
    value.code,
    cause.code,
  ]);
  return new GeminiIntegrationError(safe, { category, httpStatus, errorClass });
}

// UUIDv7's first bytes are a timestamp; the SDK truncates IDs in filenames.
export function geminiSessionId(sessionId: string): string {
  return `${createHash('sha256').update(sessionId).digest('hex').slice(0, 16)}-${sessionId}`;
}

async function matchingGeminiRecordings(sdk: typeof SDK, config: SDK.Config, sessionId: string) {
  const directory = path.join(config.storage.getProjectTempDir(), 'chats');
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new GeminiIntegrationError('Gemini recordings could not be inspected.');
  }
  const matches: string[] = [];
  for (const name of names) {
    if (!/^session-.*\.jsonl?$/.test(name)) continue;
    const file = path.join(directory, name);
    let isFile: boolean;
    try {
      isFile = (await fs.lstat(file)).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new GeminiIntegrationError('Gemini recordings could not be inspected.');
    }
    if (!isFile) continue;
    try {
      const record = await sdk.loadConversationRecord(file, { metadataOnly: true });
      if (record?.sessionId === sessionId && record.hasResumableContent) matches.push(file);
    } catch {
      // A damaged record cannot be resumed; keep inspecting other candidates.
    }
  }
  return matches;
}

export async function findGeminiRecording(
  sdk: typeof SDK,
  config: SDK.Config,
  sessionId: string,
  agorSessionId = sessionId
) {
  const matches = await matchingGeminiRecordings(sdk, config, sessionId);
  const unique = matches.filter((file) => !file.endsWith('.json') || !matches.includes(`${file}l`));
  if (unique.length <= 1) return unique[0];
  if (process.env[GEMINI_RESET_HISTORY_FOR] !== agorSessionId) {
    throw new GeminiIntegrationError(
      `Multiple Gemini recordings match this session. Set ${GEMINI_RESET_HISTORY_FOR} to this session ID for one turn to quarantine them and start fresh.`
    );
  }
  const quarantine = await fs.mkdtemp(path.join(path.dirname(matches[0]), '.agor-quarantine-'));
  try {
    for (const file of matches) await fs.rename(file, path.join(quarantine, path.basename(file)));
  } catch {
    throw new GeminiIntegrationError('Gemini recordings could not be quarantined.');
  }
  return undefined;
}

// A negative PID lookup is meaningful only in the same boot and PID namespace.
async function processNamespace(): Promise<string | undefined> {
  try {
    if (process.platform === 'linux') {
      const [boot, namespace] = await Promise.all([
        fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
        fs.readlink('/proc/self/ns/pid'),
      ]);
      return `${boot.trim()}:${namespace}`;
    }
    if (process.platform === 'darwin') {
      const { stdout } = await promisify(execFile)('/usr/sbin/sysctl', ['-n', 'kern.boottime'], {
        timeout: 1000,
      });
      return `${hostname()}:${stdout.trim()}`;
    }
  } catch {
    // Unknown ownership is retained, never interpreted as a dead local process.
  }
  return undefined;
}

/** Executors are task-scoped processes. Suppress SDK console output even on report-write failure. */
export async function enterGeminiRuntime() {
  // Delegated execution-home launchers supply the executor's HOME, while
  // branch-scoped sessions can explicitly project GEMINI_CLI_HOME.
  const home = process.env.GEMINI_CLI_HOME ?? process.env.HOME;
  if (!home || !path.isAbsolute(home))
    throw new GeminiIntegrationError('Gemini session has no SDK home; the task was not started.');
  for (const key of [...Object.values(PROVIDER_CREDENTIAL_FIELDS).flat(), 'GOOGLE_API_KEY']) {
    if (key) delete process.env[key];
  }
  // Prefer launcher-provided Job-local scratch so task temp never lands on a shared network home.
  const scratch = process.env[EXECUTOR_SCRATCH_ROOT_ENV]?.trim();
  if (scratch !== undefined && !path.isAbsolute(scratch))
    throw new GeminiIntegrationError(
      'Executor scratch directory is not an absolute path; the task was not started.'
    );
  const root = scratch
    ? path.join(scratch, 'gemini-task-tmp')
    : path.join(home, '.gemini', 'agor-task-tmp');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const namespace = await processNamespace();
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!namespace || !entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    let owner: { namespace?: string; pid?: number };
    try {
      owner = JSON.parse(await fs.readFile(path.join(directory, 'owner.json'), 'utf8'));
    } catch {
      continue;
    }
    if (owner?.namespace !== namespace || !Number.isSafeInteger(owner.pid) || owner.pid! <= 0)
      continue;
    try {
      process.kill(owner.pid!, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  }
  const temp = await fs.mkdtemp(path.join(root, `${process.pid}-`));
  await fs.writeFile(
    path.join(temp, 'owner.json'),
    JSON.stringify({ namespace, pid: process.pid }),
    {
      mode: 0o600,
    }
  );
  await fs.chmod(temp, 0o700);
  const previous = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = temp;
  const methods = ['log', 'warn', 'error', 'debug', 'info'] as const;
  const original = Object.fromEntries(methods.map((method) => [method, console[method]]));
  for (const method of methods) console[method] = () => {};
  return async () => {
    try {
      await fs.rm(temp, { recursive: true, force: true });
    } finally {
      for (const method of methods) console[method] = original[method];
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}

export async function disposeGeminiRuntime(
  config: SDK.Config | undefined,
  cleanup: (() => Promise<void>) | undefined
): Promise<void> {
  let failed = false;
  try {
    await config?.dispose();
  } catch {
    failed = true;
  }
  try {
    await cleanup?.();
  } catch {
    failed = true;
  }
  if (failed) throw new GeminiIntegrationError('Gemini integration error.');
}
