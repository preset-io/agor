import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { OPENCODE_VERSION } from '../shared/known-models.js';
import { type OpenCodeCommand, resolvePackagedOpenCodeBinary } from './binary.js';

export {
  assertOpenCodeBinaryCompatibility,
  readOpenCodeBinaryVersion,
  resolvePackagedOpenCodeBinary,
} from './binary.js';
export { OPENCODE_VERSION };

const DEFAULT_READINESS_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const DEFAULT_MODEL_REFRESH_TIMEOUT_MS = 15_000;
const READINESS_POLL_INTERVAL_MS = 25;
const HEALTH_REQUEST_TIMEOUT_MS = 500;
const MAX_STARTUP_OUTPUT = 4_096;

export class OpenCodeCleanupUnverifiedError extends Error {
  override name = 'OpenCodeCleanupUnverifiedError';
}

export function isOpenCodeCleanupUnverifiedError(error: unknown): boolean {
  return error instanceof Error && error.name === 'OpenCodeCleanupUnverifiedError';
}

export type ManagedChild = {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  exitCode: number | null;
  kill(signal: NodeJS.Signals): boolean;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown;
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown;
  removeListener(event: 'error', listener: (error: Error) => void): unknown;
};

export type OpenCodeSanitizer = {
  text(value: string): string;
  error(value: unknown): Error;
};

function collectConfigSecrets(value: unknown): string[] {
  if (typeof value === 'string') {
    const credential = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value)?.[1];
    return credential ? [value, credential] : [value];
  }
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectConfigSecrets(item));
  return Object.values(value).flatMap((item) => collectConfigSecrets(item));
}

function collectEnvironmentSecrets(environment: NodeJS.ProcessEnv): string[] {
  const declared = new Set(
    (environment.AGOR_USER_ENV_KEYS ?? '')
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean)
  );
  return Object.entries(environment).flatMap(([key, value]) =>
    value && (declared.has(key) || /(?:KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)$/i.test(key))
      ? [value]
      : []
  );
}

export function createOpenCodeSanitizer(
  secrets: readonly unknown[],
  environment: NodeJS.ProcessEnv = process.env
): OpenCodeSanitizer {
  const uniqueSecrets = [
    ...new Set([
      ...secrets.flatMap((value) => collectConfigSecrets(value)),
      ...collectEnvironmentSecrets(environment),
    ]),
  ]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const text = (value: string) =>
    uniqueSecrets.reduce((safe, secret) => safe.replaceAll(secret, '[REDACTED]'), value);
  const error = (value: unknown): Error => {
    const failure = value instanceof Error ? value : new Error(String(value));
    const seen = new WeakSet<Error>();
    const normalize = (unsafe: Error): Error => {
      if (seen.has(unsafe)) return new Error('[Circular error cause]');
      seen.add(unsafe);

      const safe = new Error(text(unsafe.message));
      Object.defineProperty(safe, 'name', {
        value: text(unsafe.name || 'Error'),
        configurable: true,
        writable: true,
      });
      if (unsafe.stack) safe.stack = text(unsafe.stack);
      if (unsafe.cause !== undefined) {
        const safeCause =
          unsafe.cause instanceof Error
            ? normalize(unsafe.cause)
            : new Error(text(String(unsafe.cause)));
        Object.defineProperty(safe, 'cause', {
          value: safeCause,
          configurable: true,
          writable: true,
        });
      }
      return safe;
    };
    return normalize(failure);
  };
  return { text, error };
}

function assertOwnedPrivatePath(
  entry: Awaited<ReturnType<typeof lstat>>,
  expectedMode: number
): void {
  if (entry.isSymbolicLink())
    throw new Error('OpenCode native data path cannot be a symbolic link');
  if (typeof process.getuid === 'function' && entry.uid !== process.getuid()) {
    throw new Error('OpenCode native data path is not owned by the executor identity');
  }
  if ((Number(entry.mode) & 0o777) !== expectedMode) {
    throw new Error('OpenCode native data path has unsafe permissions');
  }
}

function resolveOpenCodeNativeBoundary(dataHome: string): {
  homeDir: string;
  opencodeRoot: string;
  dataHome: string;
} {
  if (!isAbsolute(dataHome)) throw new Error('OpenCode native data path must be absolute');
  const resolvedDataHome = resolve(dataHome);
  const opencodeRoot = dirname(resolvedDataHome);
  const agorRoot = dirname(opencodeRoot);
  const shareRoot = dirname(agorRoot);
  const localRoot = dirname(shareRoot);
  const homeDir = dirname(localRoot);
  if (
    basename(opencodeRoot) !== 'opencode' ||
    basename(agorRoot) !== 'agor' ||
    basename(shareRoot) !== 'share' ||
    basename(localRoot) !== '.local'
  ) {
    throw new Error('OpenCode native data path is outside its expected executor-home boundary');
  }
  return { homeDir, opencodeRoot, dataHome: resolvedDataHome };
}

async function assertOwnedDirectoryChain(boundary: string, target: string): Promise<void> {
  const child = relative(boundary, target);
  if (!child || child.startsWith('..') || isAbsolute(child)) {
    throw new Error('OpenCode native data path escaped its executor-home boundary');
  }
  let current = boundary;
  for (const segment of child.split(sep)) {
    current = join(current, segment);
    let entry: Awaited<ReturnType<typeof lstat>>;
    try {
      entry = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (entry.isSymbolicLink()) {
      throw new Error('OpenCode native data path cannot contain a symbolic link');
    }
    if (!entry.isDirectory()) {
      throw new Error('OpenCode native data ancestors must be directories');
    }
    if (typeof process.getuid === 'function' && entry.uid !== process.getuid()) {
      throw new Error('OpenCode native data path is not owned by the executor identity');
    }
    if ((Number(entry.mode) & 0o022) !== 0) {
      throw new Error('OpenCode native data ancestors cannot be group- or world-writable');
    }
  }
}

async function ensureOwnedPrivateDirectory(boundary: string, directory: string): Promise<void> {
  await assertOwnedDirectoryChain(boundary, directory);
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    entry = await lstat(directory);
  }
  if (!entry.isDirectory()) throw new Error('OpenCode native data path must be a directory');
  if ((Number(entry.mode) & 0o777) !== 0o700) await chmod(directory, 0o700);
  await assertOwnedDirectoryChain(boundary, directory);
  assertOwnedPrivatePath(await lstat(directory), 0o700);
}

export async function ensureOpenCodeDataHome(dataHome: string): Promise<void> {
  const boundary = resolveOpenCodeNativeBoundary(dataHome);
  await ensureOwnedPrivateDirectory(boundary.homeDir, boundary.opencodeRoot);
  await ensureOwnedPrivateDirectory(boundary.homeDir, boundary.dataHome);
  await ensureOwnedPrivateDirectory(boundary.homeDir, join(boundary.dataHome, 'opencode'));
}

export async function prepareOpenCodeNativeState(dataHome: string): Promise<void> {
  const boundary = resolveOpenCodeNativeBoundary(dataHome);
  await ensureOpenCodeDataHome(boundary.dataHome);
  await verifyOpenCodeAuthFileBoundary(boundary.dataHome, { allowMissing: true });
}

export async function verifyOpenCodeAuthFileBoundary(
  dataHome: string,
  options: { allowMissing?: boolean } = {}
): Promise<void> {
  const boundary = resolveOpenCodeNativeBoundary(dataHome);
  await assertOwnedDirectoryChain(boundary.homeDir, join(boundary.dataHome, 'opencode'));
  const authPath = join(boundary.dataHome, 'opencode', 'auth.json');
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(authPath);
  } catch (error) {
    if (options.allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!entry.isFile()) throw new Error('OpenCode native auth path must be a regular file');
  assertOwnedPrivatePath(entry, 0o600);
}

function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function createBoundedClose(child: ManagedChild, shutdownTimeoutMs: number): () => Promise<void> {
  let exitObserved = child.exitCode !== null;
  const exited = exitObserved
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        const observe = () => {
          exitObserved = true;
          resolve();
        };
        child.once('exit', observe);
        child.once('close', observe);
      });
  let closePromise: Promise<void> | undefined;
  return () => {
    closePromise ??= (async () => {
      if (exitObserved || child.exitCode !== null) return;
      child.kill('SIGTERM');
      if (await settlesWithin(exited, shutdownTimeoutMs)) return;
      child.kill('SIGKILL');
      if (!(await settlesWithin(exited, shutdownTimeoutMs))) {
        throw new OpenCodeCleanupUnverifiedError(
          'OpenCode server did not exit after bounded SIGTERM/SIGKILL cleanup'
        );
      }
    })();
    return closePromise;
  };
}

function waitForReadiness(
  child: ManagedChild,
  sanitizer: OpenCodeSanitizer,
  readinessTimeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const diagnostic = () => {
      const tail = sanitizer.text(output.slice(-MAX_STARTUP_OUTPUT)).trim();
      return tail ? `: ${tail}` : '';
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`${message}${diagnostic()}`));
    };
    const onData = (chunk: Buffer | string) => {
      output = `${output}${chunk.toString()}`.slice(-MAX_STARTUP_OUTPUT);
      const matches = [
        ...output.matchAll(/(?:^|\n)opencode server listening on (https?:\/\/[^\s]+)/g),
      ];
      const raw = matches.at(-1)?.[1]?.replace(/[),.;]+$/, '');
      if (!raw) return;
      try {
        const url = new URL(raw);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) {
          fail('OpenCode reported a non-loopback readiness URL');
          return;
        }
        if (settled) return;
        settled = true;
        cleanup();
        resolve(url.origin);
      } catch {
        fail('OpenCode reported malformed readiness output');
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      fail(
        `OpenCode server exited before readiness (code ${code ?? 'null'}, signal ${signal ?? 'none'})`
      );
    const onError = (error: Error) => fail(`OpenCode server failed to start: ${error.message}`);
    const timer = setTimeout(
      () => fail(`OpenCode server readiness timed out after ${readinessTimeoutMs}ms`),
      readinessTimeoutMs
    );
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function waitForAuthenticatedHealth(
  child: ManagedChild,
  baseUrl: string,
  authorization: string,
  deadline: number,
  fetchHealth: typeof globalThis.fetch
): Promise<void> {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('OpenCode server exited before authenticated health readiness');
    }

    const remainingMs = deadline - Date.now();
    const controller = new AbortController();
    const requestTimer = setTimeout(
      () => controller.abort(),
      Math.min(HEALTH_REQUEST_TIMEOUT_MS, remainingMs)
    );
    try {
      const response = await fetchHealth(`${baseUrl}/global/health`, {
        headers: { Authorization: authorization },
        signal: controller.signal,
      });
      if (response.ok) return;
      await response.body?.cancel();
    } catch {
      // The listener can precede HTTP readiness; retry within the startup bound.
    } finally {
      clearTimeout(requestTimer);
    }

    const delayMs = Math.min(READINESS_POLL_INTERVAL_MS, deadline - Date.now());
    if (delayMs > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
  }

  throw new Error('OpenCode server authenticated health readiness timed out');
}

export type ManagedOpenCodeServer = {
  baseUrl: string;
  authorization: string;
  sanitizer: OpenCodeSanitizer;
  close(): Promise<void>;
};

export type ManagedOpenCodeServerDependencies = {
  resolveBinary?: () => Promise<string | OpenCodeCommand>;
  spawn?: (executable: string, args: readonly string[], options: SpawnOptions) => ManagedChild;
  randomBytes?: typeof nodeRandomBytes;
  fetch?: typeof globalThis.fetch;
  readinessTimeoutMs?: number;
  shutdownTimeoutMs?: number;
};

export type RefreshOpenCodeModelsDependencies = Pick<
  ManagedOpenCodeServerDependencies,
  'resolveBinary' | 'spawn' | 'shutdownTimeoutMs'
> & {
  refreshTimeoutMs?: number;
};

function openCodeNativeEnvironment(dataHome?: string): NodeJS.ProcessEnv {
  return dataHome
    ? {
        XDG_DATA_HOME: dataHome,
        XDG_CONFIG_HOME: join(dataHome, 'xdg-config'),
        XDG_CACHE_HOME: join(dataHome, 'xdg-cache'),
        XDG_STATE_HOME: join(dataHome, 'xdg-state'),
      }
    : {};
}

async function prepareOpenCodeNativeEnvironment(
  dataHome: string | undefined,
  nativeEnvironment: NodeJS.ProcessEnv
): Promise<void> {
  if (!dataHome) return;
  const boundary = resolveOpenCodeNativeBoundary(dataHome);
  await prepareOpenCodeNativeState(boundary.dataHome);
  await Promise.all(
    Object.values(nativeEnvironment)
      .filter((directory): directory is string =>
        Boolean(directory && directory !== boundary.dataHome)
      )
      .map((directory) => ensureOwnedPrivateDirectory(boundary.homeDir, directory))
  );
}

/**
 * Refresh the models.dev cache in the exact native-state namespace used by a
 * task's managed server. This process never substitutes for server-side model
 * validation: callers must restart OpenCode and re-check the exact pair.
 */
export async function refreshOpenCodeModels(
  input: {
    directory: string;
    providerId: string;
    dataHome: string;
    environment?: NodeJS.ProcessEnv;
    secrets?: readonly unknown[];
    signal?: AbortSignal;
  },
  dependencies: RefreshOpenCodeModelsDependencies = {}
): Promise<void> {
  if (!input.dataHome.trim()) {
    throw new Error('OpenCode model catalog refresh requires a private native data home');
  }
  const nativeEnvironment = openCodeNativeEnvironment(input.dataHome);
  await prepareOpenCodeNativeEnvironment(input.dataHome, nativeEnvironment);
  if (input.signal?.aborted) throw new Error('OpenCode model catalog refresh was aborted');

  const environment = {
    ...process.env,
    ...input.environment,
    ...nativeEnvironment,
  };
  const sanitizer = createOpenCodeSanitizer(
    [input.dataHome ?? '', input.secrets ?? [], input.environment],
    environment
  );
  const resolveBinary = dependencies.resolveBinary ?? resolvePackagedOpenCodeBinary;
  const spawn =
    dependencies.spawn ??
    ((executable: string, args: readonly string[], options: SpawnOptions) =>
      nodeSpawn(executable, [...args], options));

  let child: ManagedChild;
  try {
    const resolvedCommand = await resolveBinary();
    const command =
      typeof resolvedCommand === 'string'
        ? { executable: resolvedCommand, argsPrefix: [] }
        : resolvedCommand;
    child = spawn(
      command.executable,
      [...command.argsPrefix, 'models', input.providerId, '--refresh'],
      {
        cwd: input.directory,
        detached: false,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
  } catch (error) {
    throw sanitizer.error(error);
  }

  const close = createBoundedClose(
    child,
    dependencies.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  );
  let output = '';
  const onData = (chunk: Buffer | string) => {
    output = `${output}${chunk.toString()}`.slice(-MAX_STARTUP_OUTPUT);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  let timer: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveCompletion, rejectCompletion) => {
      child.once('close', (code, signal) => resolveCompletion({ code, signal }));
      child.once('error', rejectCompletion);
    }
  );
  const timeout = new Promise<never>((_, rejectTimeout) => {
    timer = setTimeout(
      () => rejectTimeout(new Error('OpenCode model catalog refresh timed out')),
      dependencies.refreshTimeoutMs ?? DEFAULT_MODEL_REFRESH_TIMEOUT_MS
    );
  });
  const aborted = new Promise<never>((_, rejectAbort) => {
    if (!input.signal) return;
    abortHandler = () => rejectAbort(new Error('OpenCode model catalog refresh was aborted'));
    input.signal.addEventListener('abort', abortHandler, { once: true });
  });

  try {
    const result = await Promise.race([completion, timeout, aborted]);
    if (result.code !== 0) {
      const diagnostic = sanitizer.text(output).trim();
      throw new Error(
        `OpenCode model catalog refresh exited with code ${result.code ?? 'null'} (signal ${result.signal ?? 'none'})${diagnostic ? `: ${diagnostic}` : ''}`
      );
    }
  } catch (error) {
    try {
      await close();
    } catch (closeError) {
      throw sanitizer.error(
        new OpenCodeCleanupUnverifiedError('OpenCode model catalog refresh cleanup failed', {
          cause: new AggregateError(
            [error, closeError],
            'OpenCode model catalog refresh and cleanup both failed'
          ),
        })
      );
    }
    throw sanitizer.error(error);
  } finally {
    if (timer) clearTimeout(timer);
    if (abortHandler) input.signal?.removeEventListener('abort', abortHandler);
    child.stdout?.off('data', onData);
    child.stderr?.off('data', onData);
  }
}

export async function startManagedOpenCodeServer(
  input: {
    directory: string;
    dataHome?: string;
    environment?: NodeJS.ProcessEnv;
    secrets?: readonly unknown[];
  },
  dependencies: ManagedOpenCodeServerDependencies = {}
): Promise<ManagedOpenCodeServer> {
  const nativeEnvironment = openCodeNativeEnvironment(input.dataHome);
  await prepareOpenCodeNativeEnvironment(input.dataHome, nativeEnvironment);

  const randomBytes = dependencies.randomBytes ?? nodeRandomBytes;
  const password = randomBytes(32).toString('base64url');
  const username = 'agor';
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const environment = {
    ...process.env,
    ...input.environment,
    ...nativeEnvironment,
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
  };
  const sanitizer = createOpenCodeSanitizer(
    [password, authorization, input.dataHome ?? '', input.secrets ?? [], input.environment],
    environment
  );
  const resolveBinary = dependencies.resolveBinary ?? resolvePackagedOpenCodeBinary;
  const spawn =
    dependencies.spawn ??
    ((executable: string, args: readonly string[], options: SpawnOptions) =>
      nodeSpawn(executable, [...args], options));

  let child: ManagedChild;
  try {
    const resolvedCommand = await resolveBinary();
    const command =
      typeof resolvedCommand === 'string'
        ? { executable: resolvedCommand, argsPrefix: [] }
        : resolvedCommand;
    child = spawn(
      command.executable,
      [...command.argsPrefix, 'serve', '--hostname=127.0.0.1', '--port=0'],
      {
        cwd: input.directory,
        detached: false,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
  } catch (error) {
    throw sanitizer.error(error);
  }
  const close = createBoundedClose(
    child,
    dependencies.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  );
  const readinessTimeoutMs = dependencies.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const readinessDeadline = Date.now() + readinessTimeoutMs;
  try {
    const baseUrl = await waitForReadiness(child, sanitizer, readinessTimeoutMs);
    await waitForAuthenticatedHealth(
      child,
      baseUrl,
      authorization,
      readinessDeadline,
      dependencies.fetch ?? globalThis.fetch
    );
    return { baseUrl, authorization, sanitizer, close };
  } catch (error) {
    try {
      await close();
    } catch (closeError) {
      throw sanitizer.error(
        new OpenCodeCleanupUnverifiedError('OpenCode startup cleanup could not be verified', {
          cause: new AggregateError(
            [error, closeError],
            'OpenCode startup and cleanup both failed'
          ),
        })
      );
    }
    throw sanitizer.error(error);
  }
}
