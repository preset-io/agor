import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, lstat, mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OPENCODE_VERSION = '1.14.33';
const DEFAULT_READINESS_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const READINESS_POLL_INTERVAL_MS = 25;
const HEALTH_REQUEST_TIMEOUT_MS = 500;
const MAX_STARTUP_OUTPUT = 4_096;

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

type PackageLocation = { packageJsonPath: string; version: string };

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

async function findPackageLocation(
  entryPath: string,
  packageName: string
): Promise<PackageLocation> {
  let current = dirname(entryPath);
  for (;;) {
    const packageJsonPath = join(current, 'package.json');
    try {
      const parsed = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (parsed.name === packageName && parsed.version) {
        return { packageJsonPath, version: parsed.version };
      }
    } catch {
      // Keep walking toward the package root.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`OpenCode package ${packageName} is not installed correctly`);
}

export async function resolvePackagedOpenCodeBinary(): Promise<string> {
  const require = createRequire(import.meta.url);
  let cli: PackageLocation;
  let sdk: PackageLocation;
  try {
    cli = await findPackageLocation(require.resolve('opencode-ai/package.json'), 'opencode-ai');
    sdk = await findPackageLocation(
      fileURLToPath(import.meta.resolve('@opencode-ai/sdk')),
      '@opencode-ai/sdk'
    );
  } catch (error) {
    throw new Error(
      `OpenCode ${OPENCODE_VERSION} is not fully installed; reinstall Agor with optional dependencies enabled`,
      { cause: error }
    );
  }

  if (cli.version !== OPENCODE_VERSION || sdk.version !== OPENCODE_VERSION) {
    throw new Error(
      `OpenCode SDK/CLI mismatch: expected ${OPENCODE_VERSION}, found SDK ${sdk.version} and CLI ${cli.version}`
    );
  }

  const packageRoot = dirname(cli.packageJsonPath);
  const binary =
    process.platform === 'win32'
      ? join(packageRoot, 'bin', 'opencode.exe')
      : join(packageRoot, 'bin', '.opencode');
  try {
    await access(binary, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
  } catch (error) {
    throw new Error(
      `Packaged OpenCode ${OPENCODE_VERSION} native binary is missing or not executable; reinstall Agor with optional dependencies enabled`,
      { cause: error }
    );
  }
  return binary;
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

export async function ensureOpenCodeDataHome(dataHome: string): Promise<void> {
  if (!isAbsolute(dataHome)) throw new Error('OpenCode native data path must be absolute');
  try {
    const existing = await lstat(dataHome);
    if (existing.isSymbolicLink()) {
      throw new Error('OpenCode native data path cannot be a symbolic link');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(dataHome, { recursive: true, mode: 0o700 });
  await chmod(dataHome, 0o700);
  const entry = await lstat(dataHome);
  if (!entry.isDirectory()) throw new Error('OpenCode native data path must be a directory');
  assertOwnedPrivatePath(entry, 0o700);
}

export async function verifyOpenCodeAuthFileBoundary(
  dataHome: string,
  options: { allowMissing?: boolean } = {}
): Promise<void> {
  const authPath = join(dataHome, 'opencode', 'auth.json');
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
        throw new Error('OpenCode server did not exit after bounded SIGTERM/SIGKILL cleanup');
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
  resolveBinary?: () => Promise<string>;
  spawn?: (executable: string, args: readonly string[], options: SpawnOptions) => ManagedChild;
  randomBytes?: typeof nodeRandomBytes;
  fetch?: typeof globalThis.fetch;
  readinessTimeoutMs?: number;
  shutdownTimeoutMs?: number;
};

export async function startManagedOpenCodeServer(
  input: {
    directory: string;
    dataHome?: string;
    environment?: NodeJS.ProcessEnv;
    secrets?: readonly unknown[];
  },
  dependencies: ManagedOpenCodeServerDependencies = {}
): Promise<ManagedOpenCodeServer> {
  if (input.dataHome) await ensureOpenCodeDataHome(input.dataHome);

  const randomBytes = dependencies.randomBytes ?? nodeRandomBytes;
  const password = randomBytes(32).toString('base64url');
  const username = 'agor';
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const environment = {
    ...process.env,
    ...input.environment,
    ...(input.dataHome ? { XDG_DATA_HOME: input.dataHome } : {}),
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
    child = spawn(await resolveBinary(), ['serve', '--hostname=127.0.0.1', '--port=0'], {
      cwd: input.directory,
      detached: false,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
        new AggregateError([error, closeError], 'OpenCode startup and cleanup both failed')
      );
    }
    throw sanitizer.error(error);
  }
}
