import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { PROVIDER_CREDENTIAL_FIELDS } from '@agor/core/types';
import type * as SDK from '@google/gemini-cli-core';

export const GEMINI_KEY_MESSAGE =
  'Gemini needs an API key. Add one in Settings → Gemini (Google-account sign-in is not supported).';
export const GEMINI_HISTORY_NOTICE =
  'Earlier Gemini conversation could not be restored; continuing without it.';
export class GeminiIntegrationError extends Error {}

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
  return new GeminiIntegrationError(safe);
}

// UUIDv7's first bytes are a timestamp; the SDK truncates IDs in filenames.
export function geminiSessionId(sessionId: string): string {
  return `${createHash('sha256').update(sessionId).digest('hex').slice(0, 16)}-${sessionId}`;
}

export async function findGeminiRecording(sdk: typeof SDK, config: SDK.Config, sessionId: string) {
  const directory = path.join(config.storage.getProjectTempDir(), 'chats');
  try {
    const matches: string[] = [];
    for (const name of await fs.readdir(directory)) {
      if (!/^session-.*\.jsonl?$/.test(name)) continue;
      const file = path.join(directory, name);
      const record = await sdk.loadConversationRecord(file, { metadataOnly: true });
      if (record?.sessionId === sessionId && record.hasResumableContent) matches.push(file);
    }
    const unique = matches.filter(
      (file) => !file.endsWith('.json') || !matches.includes(`${file}l`)
    );
    return unique.length === 1 ? unique[0] : undefined;
  } catch {
    return undefined;
  }
}

/** Executors are task-scoped processes. Suppress SDK console output even on report-write failure. */
export async function enterGeminiRuntime() {
  const home = process.env.GEMINI_CLI_HOME;
  if (!home || !path.isAbsolute(home))
    throw new GeminiIntegrationError('Gemini session has no SDK home; the task was not started.');
  for (const key of [...Object.values(PROVIDER_CREDENTIAL_FIELDS).flat(), 'GOOGLE_API_KEY']) {
    if (key) delete process.env[key];
  }
  const root = path.join(home, '.gemini', 'agor-task-tmp');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const match = /^(\d+)-/.exec(entry.name);
    if (!entry.isDirectory() || !match) continue;
    try {
      process.kill(Number(match[1]), 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        await fs.rm(path.join(root, entry.name), { recursive: true, force: true });
      }
    }
  }
  const temp = await fs.mkdtemp(path.join(root, `${process.pid}-`));
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
