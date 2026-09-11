#!/usr/bin/env node

/**
 * Experimental GitHub Codespaces lifecycle bridge for Agor.
 *
 * Authentication is delegated to the official `gh` CLI. The bridge never
 * reads or prints a token. Every action rediscovers the authenticated user's
 * Codespaces and validates owner, repository, ref, and an Agor branch marker
 * before it acts on a remote resource.
 *
 * This file uses only Node built-ins so a repository variant never installs
 * an unreviewed package at Play time. Node and `gh` are already present in the
 * Agor development container used to exercise this experimental variant.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const API_VERSION = '2026-03-10';
const RESULT_PREFIX = 'AGOR_ENVIRONMENT_RESULT=';
const FAILURE_STATES = new Set(['Failed', 'Unavailable']);
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BINDING_PATTERN = /^[0-9a-fA-F-]{16,64}$/;
const RESOURCE_NAME_PATTERN = /^[A-Za-z0-9-]{3,128}$/;
const SHA_PATTERN = /^[0-9a-fA-F]{40}$/;
const REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HEALTH_PATH_PATTERN = /^\/[A-Za-z0-9._~%/-]*$/;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const STATE_DIR_ENV_VAR = 'AGOR_CODESPACES_STATE_DIR';
const REMOTE_REVISION_PREFIX = 'AGOR_CODESPACE_REVISION=';

// This script runs through `bash -s` in the already-validated Codespace. Its
// positional arguments are shell-quoted by the local launcher. It refuses to
// mutate a dirty, detached, or wrong-origin checkout, fetches the configured
// ref, proves the requested object is reachable from it, then restarts from
// exactly that object while preserving the symbolic branch name. The bootstrap
// independently proves whether its existing development image matches the
// selected revision's image inputs before deciding whether to rebuild it.
const REMOTE_SYNC_SCRIPT = `${[
  'set -euo pipefail',
  'workspace=$1',
  'expected_repository=$2',
  'expected_ref=$3',
  'revision=$4',
  'codespace_name=$5',
  'fail() { printf "%s\\n" "$1" >&2; exit 70; }',
  'cd -- "$workspace" || fail "Codespace workspace is missing"',
  'actual_ref=$(git symbolic-ref --quiet --short HEAD) || fail "Codespace checkout is detached"',
  '[ "$actual_ref" = "$expected_ref" ] || fail "Codespace checkout is on the wrong ref"',
  'origin_url=$(git remote get-url origin) || fail "Codespace checkout has no origin"',
  'origin_lower=$(printf "%s" "$origin_url" | tr "[:upper:]" "[:lower:]")',
  'repository_lower=$(printf "%s" "$expected_repository" | tr "[:upper:]" "[:lower:]")',
  'case "$origin_lower" in',
  '  "https://github.com/$repository_lower"|"https://github.com/$repository_lower.git"|"git@github.com:$repository_lower"|"git@github.com:$repository_lower.git"|"ssh://git@github.com/$repository_lower"|"ssh://git@github.com/$repository_lower.git") ;;',
  '  *) fail "Codespace checkout origin does not match the requested repository" ;;',
  'esac',
  '[ -z "$(git status --porcelain=v1 --untracked-files=normal)" ] || fail "Codespace checkout is dirty; refusing to overwrite developer work"',
  'git fetch --no-tags -- origin "$expected_ref"',
  'git cat-file -e "$revision^{commit}" 2>/dev/null || fail "Requested revision is not available from GitHub"',
  'git merge-base --is-ancestor "$revision" FETCH_HEAD || fail "Requested revision is not reachable from the configured ref"',
  // Compose down intentionally preserves named data, but it also strands every
  // anonymous dependency volume. Remove the service first with -v, which
  // deletes only its anonymous volumes, then remove the project network.
  'docker compose -p agor-codespaces-sqlite rm -sfv agor-dev',
  'docker compose -p agor-codespaces-sqlite down',
  'git reset --hard "$revision"',
  'env CODESPACE_NAME="$codespace_name" bash .devcontainer/agor-managed/start-agor-sqlite.sh',
  '[ "$(git rev-parse HEAD)" = "$revision" ] || fail "Codespace HEAD changed during bootstrap"',
  '[ -z "$(git status --porcelain=v1 --untracked-files=normal)" ] || fail "Codespace checkout became dirty during bootstrap"',
].join('\n')}\n`;

const REMOTE_VERIFY_SCRIPT = `${[
  'set -euo pipefail',
  'workspace=$1',
  'expected_repository=$2',
  'expected_ref=$3',
  'revision=$4',
  'fail() { printf "%s\\n" "$1" >&2; exit 70; }',
  'cd -- "$workspace" || fail "Codespace workspace is missing"',
  'actual_ref=$(git symbolic-ref --quiet --short HEAD) || fail "Codespace checkout is detached"',
  '[ "$actual_ref" = "$expected_ref" ] || fail "Codespace checkout is on the wrong ref"',
  'origin_url=$(git remote get-url origin) || fail "Codespace checkout has no origin"',
  'origin_lower=$(printf "%s" "$origin_url" | tr "[:upper:]" "[:lower:]")',
  'repository_lower=$(printf "%s" "$expected_repository" | tr "[:upper:]" "[:lower:]")',
  'case "$origin_lower" in',
  '  "https://github.com/$repository_lower"|"https://github.com/$repository_lower.git"|"git@github.com:$repository_lower"|"git@github.com:$repository_lower.git"|"ssh://git@github.com/$repository_lower"|"ssh://git@github.com/$repository_lower.git") ;;',
  '  *) fail "Codespace checkout origin does not match the requested repository" ;;',
  'esac',
  'actual_revision=$(git rev-parse HEAD)',
  '[ "$actual_revision" = "$revision" ] || fail "Codespace HEAD does not match the requested revision"',
  '[ -z "$(git status --porcelain=v1 --untracked-files=normal)" ] || fail "Codespace checkout is dirty after bootstrap"',
  `printf '${REMOTE_REVISION_PREFIX}%s\\n' "$actual_revision"`,
].join('\n')}\n`;

export class LauncherError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'LauncherError';
  }
}

export function redact(value) {
  return String(value ?? '')
    .replace(
      /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/g,
      '[REDACTED]'
    )
    .replace(/(authorization\s*:\s*(?:bearer|token)\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:access_token|auth|key|secret|token)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/(\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*[=:]\s*)[^\s]+/gi, '$1[REDACTED]')
    .replace(/^\s*AGOR_(?:FACT|ENVIRONMENT_RESULT)\s*=?.*$/gim, '[provider control line omitted]');
}

function appendBounded(chunks, chunk, byteCount) {
  let buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (buffer.length > MAX_COMMAND_OUTPUT_BYTES) {
    buffer = buffer.subarray(buffer.length - MAX_COMMAND_OUTPUT_BYTES);
    chunks.length = 0;
    byteCount = 0;
  }
  chunks.push(buffer);
  let total = byteCount + buffer.length;
  while (total > MAX_COMMAND_OUTPUT_BYTES && chunks.length > 0) {
    const removed = chunks.shift();
    total -= removed.length;
  }
  return total;
}

export function runCommand(argv, { inputText, timeout = 30, check = true } = {}) {
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.some((value) => typeof value !== 'string')
  ) {
    return Promise.reject(new LauncherError('provider command argv is invalid'));
  }

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timedOut = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks = [];
    const stderrChunks = [];
    const child = spawn(argv[0], argv.slice(1), {
      env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout * 1_000);

    child.stdout.on('data', (chunk) => {
      stdoutBytes = appendBounded(stdoutChunks, chunk, stdoutBytes);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes = appendBounded(stderrChunks, chunk, stderrBytes);
    });
    // A provider process can reject stdin before Node finishes writing the
    // JSON body. Its exit code/stderr is the useful failure; do not let EPIPE
    // become an uncaught process-level error.
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        rejectPromise(new LauncherError('GitHub CLI (`gh`) is required but was not found'));
        return;
      }
      rejectPromise(new LauncherError('GitHub CLI command could not be started'));
    });
    child.on('close', (returncode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        rejectPromise(new LauncherError(`provider command timed out after ${timeout}s`));
        return;
      }

      const result = {
        returncode: returncode ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      };
      if (check && result.returncode !== 0) {
        let detail = redact((result.stderr || result.stdout).trim());
        if (detail.length > 2_000) detail = `...${detail.slice(-2_000)}`;
        rejectPromise(
          new LauncherError(
            `GitHub CLI command failed with exit code ${result.returncode}${detail ? `: ${detail}` : ''}`
          )
        );
        return;
      }
      resolvePromise(result);
    });

    if (inputText === undefined) child.stdin.end();
    else child.stdin.end(inputText);
  });
}

export class GitHubCodespacesClient {
  constructor({ runner = runCommand, callTimeout = 30 } = {}) {
    this.runner = runner;
    this.callTimeout = callTimeout;
  }

  async api(endpoint, { method = 'GET', body } = {}) {
    const argv = [
      'gh',
      'api',
      '--method',
      method,
      '-H',
      `X-GitHub-Api-Version:${API_VERSION}`,
      endpoint,
    ];
    let inputText;
    if (body !== undefined) {
      argv.push('--input', '-');
      inputText = JSON.stringify(body);
    }
    const result = await this.runner(argv, {
      inputText,
      timeout: this.callTimeout,
      check: true,
    });
    if (!result.stdout.trim()) return undefined;
    try {
      return JSON.parse(result.stdout);
    } catch (error) {
      throw new LauncherError('GitHub API returned invalid JSON', { cause: error });
    }
  }

  async viewer() {
    const response = await this.api('user');
    if (typeof response?.login !== 'string' || !response.login) {
      throw new LauncherError('GitHub API did not return the authenticated actor');
    }
    return response.login;
  }

  async repository(repository) {
    const response = await this.api(`repos/${repository}`);
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw new LauncherError('GitHub API did not return the repository');
    }
    return response;
  }

  async resolveRef(repository, ref) {
    let response;
    try {
      response = await this.api(`repos/${repository}/commits/${encodeURIComponent(ref)}`);
    } catch (error) {
      // Discovery has already proven that this actor can read the repository.
      // GitHub reports an unknown commit/ref from this endpoint as 404 or as
      // "No commit found for SHA" with 422. Explain the local-vs-remote
      // boundary instead of leaking the provider's SHA-oriented wording.
      if (
        error instanceof LauncherError &&
        /\bHTTP (?:404|422)\b/.test(error.message) &&
        /(?:No commit found for SHA|Not Found)/i.test(error.message)
      ) {
        throw new LauncherError(
          `GitHub cannot find ref ${JSON.stringify(ref)} in ${repository}. Push this branch or commit to GitHub before pressing Play; Codespaces cannot access an Agor-only local ref.`,
          { cause: error }
        );
      }
      throw error;
    }
    if (typeof response?.sha !== 'string' || !SHA_PATTERN.test(response.sha)) {
      throw new LauncherError(`GitHub did not resolve ref ${JSON.stringify(ref)} to a commit`);
    }
    return response.sha.toLowerCase();
  }

  async listCodespaces(repository) {
    const [owner, repo] = repository.split('/', 2);
    const result = await this.runner(
      [
        'gh',
        'api',
        '--method',
        'GET',
        '-H',
        `X-GitHub-Api-Version:${API_VERSION}`,
        '--paginate',
        '--slurp',
        `repos/${owner}/${repo}/codespaces?per_page=100`,
      ],
      { timeout: this.callTimeout, check: true }
    );
    let pages;
    try {
      pages = JSON.parse(result.stdout);
    } catch (error) {
      throw new LauncherError('GitHub API returned invalid Codespaces list JSON', { cause: error });
    }
    if (!Array.isArray(pages)) {
      throw new LauncherError('GitHub API did not return Codespaces list pages');
    }
    const codespaces = [];
    for (const page of pages) {
      if (!Array.isArray(page?.codespaces)) {
        throw new LauncherError('GitHub API returned an invalid Codespaces list page');
      }
      codespaces.push(...page.codespaces.filter(isRecord));
    }
    return codespaces;
  }

  async createCodespace(
    repository,
    ref,
    displayName,
    devcontainerPath,
    idleTimeoutMinutes,
    retentionPeriodMinutes
  ) {
    const [owner, repo] = repository.split('/', 2);
    const response = await this.api(`repos/${owner}/${repo}/codespaces`, {
      method: 'POST',
      body: {
        ref,
        display_name: displayName,
        devcontainer_path: devcontainerPath,
        idle_timeout_minutes: idleTimeoutMinutes,
        retention_period_minutes: retentionPeriodMinutes,
      },
    });
    if (!isRecord(response)) {
      throw new LauncherError('GitHub API did not return the created Codespace');
    }
    return response;
  }

  async getCodespace(name) {
    const response = await this.api(`user/codespaces/${name}`);
    if (!isRecord(response)) throw new LauncherError('GitHub API did not return the Codespace');
    return response;
  }

  async startCodespace(name) {
    await this.api(`user/codespaces/${name}/start`, { method: 'POST' });
  }

  async stopCodespace(name) {
    await this.api(`user/codespaces/${name}/stop`, { method: 'POST' });
  }

  async deleteCodespace(name) {
    await this.api(`user/codespaces/${name}`, { method: 'DELETE' });
  }

  async listPorts(name) {
    const result = await this.runner(
      ['gh', 'codespace', 'ports', '-c', name, '--json', 'sourcePort,visibility,label,browseUrl'],
      { timeout: this.callTimeout, check: true }
    );
    let ports;
    try {
      ports = JSON.parse(result.stdout);
    } catch (error) {
      throw new LauncherError('GitHub CLI returned invalid port JSON', { cause: error });
    }
    if (!Array.isArray(ports)) throw new LauncherError('GitHub CLI did not return a port list');
    return ports.filter(isRecord);
  }

  async setPortVisibility(name, ports, visibility) {
    const targets = [...new Set(ports)].sort((left, right) => left - right);
    await this.runner(
      [
        'gh',
        'codespace',
        'ports',
        'visibility',
        ...targets.map((port) => `${port}:${visibility}`),
        '-c',
        name,
      ],
      { timeout: this.callTimeout, check: true }
    );
  }

  async remoteHealth(name, healthPort, healthPath) {
    const healthUrl = `http://127.0.0.1:${healthPort}${healthPath}`;
    // Use a reserved exit status for an ordinary not-ready response. That
    // lets us distinguish curl health failures from a broken Codespaces SSH
    // transport (for example, a custom devcontainer with no SSH server).
    const command = `curl -fsS --max-time 5 ${shellQuote(healthUrl)} >/dev/null || exit 42`;
    const result = await this.runner(['gh', 'codespace', 'ssh', '-c', name, '--', command], {
      timeout: this.callTimeout,
      check: false,
    });
    if (result.returncode === 0) return true;
    // OpenSSH preserves the remote command's exit status, but `gh codespace
    // ssh` currently wraps any non-zero remote status as local exit 1 and
    // writes the original status to stderr. Accept both representations for
    // our reserved ordinary-not-ready code.
    if (
      result.returncode === 42 ||
      /(?:^|\n)shell closed: exit status 42\s*$/m.test(`${result.stdout}\n${result.stderr}`)
    ) {
      return false;
    }

    let detail = redact((result.stderr || result.stdout).trim());
    if (detail.length > 2_000) detail = `...${detail.slice(-2_000)}`;
    throw new LauncherError(
      `Codespaces SSH health probe failed with exit code ${result.returncode}${detail ? `: ${detail}` : ''}`
    );
  }

  async creationLogs(name) {
    const result = await this.runner(['gh', 'codespace', 'logs', '-c', name], {
      timeout: Math.max(this.callTimeout, 60),
      check: true,
    });
    return redact(result.stdout);
  }

  async runtimeLogs(name, repository) {
    const repoName = repository.split('/', 2)[1];
    const command = `cd ${shellQuote(`/workspaces/${repoName}`)} && docker compose -p agor-codespaces-sqlite logs --tail=150`;
    const result = await this.runner(['gh', 'codespace', 'ssh', '-c', name, '--', command], {
      timeout: Math.max(this.callTimeout, 60),
      check: true,
    });
    return redact(result.stdout);
  }

  async runBootstrap(name, repository, { force = false, recreate = false, timeout = 600 } = {}) {
    assertResourceName(name);
    const repoName = repository.split('/', 2)[1];
    const workspace = `/workspaces/${repoName}`;
    const command = [
      `cd ${shellQuote(workspace)}`,
      '&&',
      'env',
      `CODESPACE_NAME=${shellQuote(name)}`,
      `AGOR_FORCE_REBUILD=${shellQuote(force ? 'true' : 'false')}`,
      `AGOR_FORCE_RECREATE=${shellQuote(recreate ? 'true' : 'false')}`,
      'bash',
      shellQuote('.devcontainer/agor-managed/start-agor-sqlite.sh'),
    ].join(' ');
    await this.runner(['gh', 'codespace', 'ssh', '-c', name, '--', command], {
      timeout: Math.max(this.callTimeout, timeout),
      check: true,
    });
  }

  async syncWorkspace(name, repository, ref, revision, { timeout = 600 } = {}) {
    assertResourceName(name);
    const repoName = repository.split('/', 2)[1];
    const command = `bash -s -- ${[`/workspaces/${repoName}`, repository, ref, revision, name]
      .map(shellQuote)
      .join(' ')}`;
    await this.runner(['gh', 'codespace', 'ssh', '-c', name, '--', command], {
      inputText: REMOTE_SYNC_SCRIPT,
      timeout: Math.max(this.callTimeout, timeout),
      check: true,
    });
  }

  async verifyWorkspaceRevision(name, repository, ref, revision) {
    assertResourceName(name);
    const repoName = repository.split('/', 2)[1];
    const command = `bash -s -- ${[`/workspaces/${repoName}`, repository, ref, revision]
      .map(shellQuote)
      .join(' ')}`;
    const result = await this.runner(['gh', 'codespace', 'ssh', '-c', name, '--', command], {
      inputText: REMOTE_VERIFY_SCRIPT,
      timeout: this.callTimeout,
      check: true,
    });
    const matches = result.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith(REMOTE_REVISION_PREFIX));
    if (matches.length !== 1) {
      throw new LauncherError('Codespace revision verification returned an invalid result');
    }
    const actual = matches[0].slice(REMOTE_REVISION_PREFIX.length);
    if (!REVISION_PATTERN.test(actual)) {
      throw new LauncherError('Codespace revision verification returned an invalid object ID');
    }
    return actual;
  }
}

export function normalizeRef(ref) {
  for (const prefix of ['refs/heads/', 'refs/tags/']) {
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  }
  return ref;
}

export function markerFor(repository, binding) {
  const digest = createHash('sha256')
    .update(`${repository.toLowerCase()}\0${binding.toLowerCase()}`)
    .digest('hex');
  return `agor-cs-${digest.slice(0, 28)}`;
}

export function resourceName(resource) {
  assertResourceName(resource?.name);
  return resource.name;
}

function assertResourceName(name) {
  if (typeof name !== 'string' || !RESOURCE_NAME_PATTERN.test(name)) {
    throw new LauncherError('Codespace has an invalid resource name');
  }
}

export function validateResource(resource, { owner, repository, repositoryId, ref, marker }) {
  const actualOwner = resource?.owner?.login;
  const actualRepository = resource?.repository?.full_name;
  const actualRepositoryId = resource?.repository?.id;
  const actualRef = normalizeRef(String(resource?.git_status?.ref ?? ''));
  const mismatches = [];
  if (String(actualOwner).toLowerCase() !== owner.toLowerCase()) mismatches.push('owner');
  if (String(actualRepository).toLowerCase() !== repository.toLowerCase()) {
    mismatches.push('repository');
  }
  if (actualRepositoryId !== repositoryId) mismatches.push('repository ID');
  if (actualRef !== normalizeRef(ref)) mismatches.push('ref');
  if (resource?.display_name !== marker) mismatches.push('binding marker');
  if (mismatches.length > 0) {
    throw new LauncherError(
      `refusing Codespace ${JSON.stringify(resourceName(resource))}: mismatched ${mismatches.join(', ')}`
    );
  }
}

export class StateStore {
  constructor(directory, repository, binding) {
    const digest = createHash('sha256')
      .update(`${repository.toLowerCase()}\0${binding.toLowerCase()}`)
      .digest('hex');
    this.directory = directory;
    this.path = join(directory, `${digest}.json`);
    this.lockDirectory = join(directory, `${digest}.node-lock`);
  }

  async ensureDirectory() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700).catch((error) => {
      if (error.code !== 'EPERM') throw error;
    });
  }

  async withLock(work, { waitMilliseconds = 10 * 60_000 } = {}) {
    await this.ensureDirectory();
    const deadline = Date.now() + waitMilliseconds;
    while (true) {
      try {
        await mkdir(this.lockDirectory, { mode: 0o700 });
        await writeFile(
          join(this.lockDirectory, 'owner.json'),
          `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
          { mode: 0o600, flag: 'wx' }
        );
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (await this.removeStaleLock()) continue;
        if (Date.now() >= deadline) {
          throw new LauncherError('timed out waiting for another Codespaces lifecycle action');
        }
        await delay(250);
      }
    }

    try {
      return await work();
    } finally {
      await rm(this.lockDirectory, { recursive: true, force: true });
    }
  }

  async removeStaleLock() {
    let owner;
    try {
      owner = JSON.parse(await readFile(join(this.lockDirectory, 'owner.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        const lockStat = await stat(this.lockDirectory).catch(() => undefined);
        if (lockStat && Date.now() - lockStat.mtimeMs > 30_000) {
          await rm(this.lockDirectory, { recursive: true, force: true });
          return true;
        }
        return false;
      }
      return false;
    }
    if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1) {
      const lockStat = await stat(this.lockDirectory).catch(() => undefined);
      if (!lockStat || Date.now() - lockStat.mtimeMs <= 30_000) return false;
    } else if (processIsAlive(owner.pid)) {
      return false;
    }
    await rm(this.lockDirectory, { recursive: true, force: true });
    return true;
  }

  async load() {
    let raw;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
    let value;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new LauncherError(`invalid local Codespace binding state: ${this.path}`, {
        cause: error,
      });
    }
    if (!isRecord(value)) {
      throw new LauncherError(`invalid local Codespace binding state: ${this.path}`);
    }
    return value;
  }

  async save(value) {
    await this.ensureDirectory();
    const temporary = join(
      this.directory,
      `.${basename(this.path)}.${process.pid}.${randomBytes(8).toString('hex')}`
    );
    let handle;
    try {
      handle = await open(
        temporary,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600
      );
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.path);
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  async clear() {
    await unlink(this.path).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export class CodespaceController {
  constructor({
    client,
    store,
    repository,
    ref,
    binding,
    devcontainerPath,
    idleTimeoutMinutes,
    retentionPeriodMinutes,
    appPort,
    healthPort,
    healthPath,
    portVisibility,
    waitSeconds,
    sleep = delay,
    monotonic = () => performance.now() / 1_000,
  }) {
    this.client = client;
    this.store = store;
    this.repository = repository;
    this.ref = normalizeRef(ref);
    this.binding = binding;
    this.marker = markerFor(repository, binding);
    this.devcontainerPath = devcontainerPath;
    this.idleTimeoutMinutes = idleTimeoutMinutes;
    this.retentionPeriodMinutes = retentionPeriodMinutes;
    this.appPort = appPort;
    this.healthPort = healthPort;
    this.healthPath = healthPath;
    this.portVisibility = portVisibility;
    this.waitSeconds = waitSeconds;
    this.sleep = sleep;
    this.monotonic = monotonic;
  }

  async discover() {
    const owner = await this.client.viewer();
    const repository = await this.client.repository(this.repository);
    const repositoryId = repository.id;
    if (
      String(repository.full_name ?? '').toLowerCase() !== this.repository.toLowerCase() ||
      !Number.isSafeInteger(repositoryId)
    ) {
      throw new LauncherError('GitHub repository identity did not match the requested repository');
    }
    const resources = await this.client.listCodespaces(this.repository);
    const state = await this.store.load();
    if (state) {
      const expected = {
        binding: this.binding,
        repository: this.repository,
        ref: this.ref,
      };
      if (Object.entries(expected).some(([key, value]) => state[key] !== value)) {
        throw new LauncherError('local Codespace binding state belongs to another branch');
      }
      if (String(state.owner ?? '').toLowerCase() !== owner.toLowerCase()) {
        throw new LauncherError(
          'this environment is bound to another GitHub actor; use the original actor to manage or nuke it'
        );
      }
      if (state.repository_id !== undefined && state.repository_id !== repositoryId) {
        throw new LauncherError('local Codespace binding state belongs to another repository ID');
      }
    }

    const matches = resources.filter((item) => item.display_name === this.marker);
    if (matches.length > 1) {
      const names = matches.map(resourceName).sort().join(', ');
      throw new LauncherError(`ambiguous Codespace binding; refusing to choose among: ${names}`);
    }
    if (matches.length === 0) {
      if (state?.name && resources.some((item) => item.name === state.name)) {
        throw new LauncherError(
          'stored Codespace still exists but no longer has the expected marker'
        );
      }
      return { owner, repositoryId, resource: undefined };
    }

    const resource = matches[0];
    validateResource(resource, {
      owner,
      repository: this.repository,
      repositoryId,
      ref: this.ref,
      marker: this.marker,
    });
    return { owner, repositoryId, resource };
  }

  async saveBinding(owner, resource, { resolvedSha } = {}) {
    const previous = (await this.store.load()) ?? {};
    await this.store.save({
      version: 1,
      binding: this.binding,
      repository: this.repository,
      repository_id: resource.repository?.id,
      ref: this.ref,
      owner,
      name: resourceName(resource),
      display_name: this.marker,
      created_ref_sha: resolvedSha ?? previous.created_ref_sha,
      updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });
  }

  async refetchAndValidate(owner, repositoryId, resource) {
    const current = await this.client.getCodespace(resourceName(resource));
    validateResource(current, {
      owner,
      repository: this.repository,
      repositoryId,
      ref: this.ref,
      marker: this.marker,
    });
    return current;
  }

  async waitForState(owner, repositoryId, name, desired) {
    const deadline = this.monotonic() + this.waitSeconds;
    while (true) {
      const resource = await this.client.getCodespace(name);
      validateResource(resource, {
        owner,
        repository: this.repository,
        repositoryId,
        ref: this.ref,
        marker: this.marker,
      });
      const state = String(resource.state ?? '');
      if (state === desired) return resource;
      if (FAILURE_STATES.has(state)) {
        throw new LauncherError(`Codespace entered terminal state ${state}`);
      }
      if (this.monotonic() >= deadline) {
        throw new LauncherError(
          `timed out after ${this.waitSeconds}s waiting for Codespace state ${desired} (last: ${state || 'unknown'})`
        );
      }
      await this.sleep(3_000);
    }
  }

  async probePreview(name) {
    const ports = await this.client.listPorts(name);
    const expectedPorts = new Set([this.appPort, this.healthPort]);
    const actualPorts = new Set(
      ports.filter((item) => Number.isSafeInteger(item.sourcePort)).map((item) => item.sourcePort)
    );
    const missing = [...expectedPorts].filter((port) => !actualPorts.has(port)).sort();
    const healthy = await this.client.remoteHealth(name, this.healthPort, this.healthPath);
    if (missing.length > 0) {
      return {
        ready: false,
        repairable: !healthy,
        ports,
        detail: `forwarded ports not registered: ${JSON.stringify(missing)}`,
      };
    }
    if (!healthy) {
      return {
        ready: false,
        repairable: true,
        ports,
        detail: 'remote Agor /health is not ready',
      };
    }
    return { ready: true, repairable: false, ports, detail: undefined };
  }

  async waitForPreview(name, { repairUnhealthy = false } = {}) {
    const deadline = this.monotonic() + this.waitSeconds;
    let lastError = 'preview not ready';
    let repairAttempted = false;
    while (true) {
      try {
        const probe = await this.probePreview(name);
        if (probe.ready) return probe.ports;
        lastError = probe.detail;
        if (repairUnhealthy && probe.repairable && !repairAttempted) {
          repairAttempted = true;
          try {
            await this.client.runBootstrap(name, this.repository, {
              recreate: true,
              timeout: this.waitSeconds,
            });
          } catch (error) {
            const detail = error instanceof LauncherError ? `: ${error.message}` : '';
            throw new LauncherError(`Codespace bootstrap repair failed${detail}`, { cause: error });
          }
        }
      } catch (error) {
        if (!(error instanceof LauncherError)) throw error;
        if (error.message.startsWith('Codespace bootstrap repair failed')) throw error;
        if (/check if an SSH server is installed/i.test(error.message)) {
          throw new LauncherError(
            `${error.message}. This Codespace was built without the SSH transport required by the launcher; rebuild its dev container or Nuke it and press Play again.`
          );
        }
        lastError = error.message;
      }
      if (this.monotonic() >= deadline) {
        throw new LauncherError(
          `timed out after ${this.waitSeconds}s waiting for the Codespace preview: ${lastError}`
        );
      }
      await this.sleep(3_000);
    }
  }

  async reconcilePortVisibility(name, ports) {
    if (this.portVisibility === 'preserve') return ports;

    const expectedPorts = [...new Set([this.appPort, this.healthPort])].sort(
      (left, right) => left - right
    );
    const byPort = new Map(ports.map((item) => [item.sourcePort, item]));
    const mismatched = expectedPorts.filter(
      (port) => String(byPort.get(port)?.visibility ?? '').toLowerCase() !== this.portVisibility
    );
    if (mismatched.length === 0) return ports;

    try {
      await this.client.setPortVisibility(name, mismatched, this.portVisibility);
    } catch (error) {
      const detail = error instanceof LauncherError ? `: ${error.message}` : '';
      throw new LauncherError(
        `could not set Codespace ports ${mismatched.join(', ')} to ${this.portVisibility}; the repository or organization Codespaces policy may prohibit that visibility${detail}`,
        { cause: error }
      );
    }

    const refreshed = await this.client.listPorts(name);
    const refreshedByPort = new Map(refreshed.map((item) => [item.sourcePort, item]));
    const unchanged = expectedPorts.filter(
      (port) =>
        String(refreshedByPort.get(port)?.visibility ?? '').toLowerCase() !== this.portVisibility
    );
    if (unchanged.length > 0) {
      throw new LauncherError(
        `GitHub did not apply ${this.portVisibility} visibility to Codespace ports ${unchanged.join(', ')}`
      );
    }
    return refreshed;
  }

  async start() {
    const discovery = await this.discover();
    let resource = discovery.resource;
    const repairUnhealthy = String(resource?.state ?? '') === 'Available';
    let resolvedSha;
    if (!resource) {
      resolvedSha = await this.client.resolveRef(this.repository, this.ref);
      resource = await this.client.createCodespace(
        this.repository,
        this.ref,
        this.marker,
        this.devcontainerPath,
        this.idleTimeoutMinutes,
        this.retentionPeriodMinutes
      );
      validateResource(resource, {
        owner: discovery.owner,
        repository: this.repository,
        repositoryId: discovery.repositoryId,
        ref: this.ref,
        marker: this.marker,
      });
    }

    let name = resourceName(resource);
    let state = String(resource.state ?? '');
    if (state === 'Shutdown') {
      resource = await this.refetchAndValidate(discovery.owner, discovery.repositoryId, resource);
      name = resourceName(resource);
      state = String(resource.state ?? '');
      if (state === 'Shutdown') await this.client.startCodespace(name);
    }
    if (FAILURE_STATES.has(state)) {
      throw new LauncherError(`Codespace is in terminal state ${state}; nuke it before retrying`);
    }

    resource = await this.waitForState(discovery.owner, discovery.repositoryId, name, 'Available');
    const readyPorts = await this.waitForPreview(name, { repairUnhealthy });
    const ports = await this.reconcilePortVisibility(name, readyPorts);
    await this.saveBinding(discovery.owner, resource, { resolvedSha });
    return { resource, ports };
  }

  async sync(revision) {
    const discovery = await this.discover();
    if (!discovery.resource) throw new LauncherError('no Codespace is bound to this branch');
    const resource = await this.refetchAndValidate(
      discovery.owner,
      discovery.repositoryId,
      discovery.resource
    );
    if (resource.state !== 'Available') {
      throw new LauncherError(`Codespace is not available (state: ${resource.state})`);
    }

    const name = resourceName(resource);
    await this.client.syncWorkspace(name, this.repository, this.ref, revision, {
      timeout: this.waitSeconds,
    });
    await this.waitForPreview(name);
    const appliedRevision = await this.client.verifyWorkspaceRevision(
      name,
      this.repository,
      this.ref,
      revision
    );
    if (appliedRevision !== revision) {
      throw new LauncherError(
        `Codespace revision verification returned ${appliedRevision}, expected ${revision}`
      );
    }
    await this.saveBinding(discovery.owner, resource);
    return appliedRevision;
  }

  async stop() {
    const discovery = await this.discover();
    if (!discovery.resource) {
      await this.store.clear();
      return undefined;
    }
    let resource = await this.refetchAndValidate(
      discovery.owner,
      discovery.repositoryId,
      discovery.resource
    );
    const name = resourceName(resource);
    if (resource.state !== 'Shutdown') await this.client.stopCodespace(name);
    resource = await this.waitForState(discovery.owner, discovery.repositoryId, name, 'Shutdown');
    await this.saveBinding(discovery.owner, resource);
    return resource;
  }

  async nuke() {
    const discovery = await this.discover();
    if (!discovery.resource) {
      await this.store.clear();
      return false;
    }
    const resource = await this.refetchAndValidate(
      discovery.owner,
      discovery.repositoryId,
      discovery.resource
    );
    await this.client.deleteCodespace(resourceName(resource));
    const deadline = this.monotonic() + this.waitSeconds;
    while (true) {
      const current = await this.discover();
      if (!current.resource) {
        await this.store.clear();
        return true;
      }
      if (this.monotonic() >= deadline) {
        throw new LauncherError(
          `timed out after ${this.waitSeconds}s waiting for Codespace deletion`
        );
      }
      await this.sleep(3_000);
    }
  }

  async health() {
    const discovery = await this.discover();
    if (!discovery.resource) throw new LauncherError('no Codespace is bound to this branch');
    const resource = discovery.resource;
    if (resource.state !== 'Available') {
      throw new LauncherError(`Codespace is not available (state: ${resource.state})`);
    }
    const ports = await this.client.listPorts(resourceName(resource));
    if (
      !(await this.client.remoteHealth(resourceName(resource), this.healthPort, this.healthPath))
    ) {
      throw new LauncherError(`remote Agor ${this.healthPath} is unhealthy`);
    }
    return { resource, ports };
  }

  async logs() {
    const discovery = await this.discover();
    if (!discovery.resource) return 'No Codespace is bound to this branch.\n';
    const resource = discovery.resource;
    const summary = JSON.stringify(publicSummary(resource, []));
    const name = resourceName(resource);
    // `gh codespace logs` uses the same SSH transport as runtime logs for a
    // custom devcontainer. Do not call either command for a stopped resource:
    // establishing that tunnel can resume billable compute.
    if (resource.state === 'Shutdown' || resource.state === 'ShuttingDown') {
      return `${summary}\nCodespace logs were skipped because GitHub CLI uses SSH and could resume or delay the stopping/stopped Codespace. Press Play before requesting Logs.\n`;
    }

    let creationSection;
    try {
      const creationLogs = await this.client.creationLogs(name);
      creationSection = `${summary}\n--- Codespace creation log ---\n${creationLogs}${creationLogs.endsWith('\n') ? '' : '\n'}`;
    } catch (error) {
      const detail =
        error instanceof LauncherError ? error.message : 'creation logs are not available yet';
      creationSection = `${summary}\n--- Codespace creation log ---\nUnavailable: ${redact(detail)}\n`;
    }
    if (resource.state !== 'Available') {
      return `${creationSection}--- Agor runtime log ---\nAgor runtime logs are not available until the Codespace is Available (current state: ${resource.state || 'unknown'}).\n`;
    }
    try {
      const runtimeLogs = await this.client.runtimeLogs(name, this.repository);
      return `${creationSection}--- Agor runtime log ---\n${runtimeLogs}`;
    } catch (error) {
      const detail =
        error instanceof LauncherError
          ? error.message
          : 'remote runtime logs are not available yet';
      return `${creationSection}--- Agor runtime log ---\nUnavailable: ${redact(detail)}\n`;
    }
  }
}

export function validatedHttpUrl(value, { codespaceName } = {}) {
  if (typeof value !== 'string' || value.length > 2_048) return undefined;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return undefined;
  }
  if (
    codespaceName &&
    parsed.hostname !== `${codespaceName}.github.dev` &&
    !(
      parsed.hostname.endsWith('.app.github.dev') && parsed.hostname.startsWith(`${codespaceName}-`)
    )
  ) {
    return undefined;
  }
  return value;
}

export function portUrl(resource, ports, port) {
  const name = resourceName(resource);
  const url = ports
    .filter((item) => item.sourcePort === port)
    .map((item) => validatedHttpUrl(item.browseUrl, { codespaceName: name }))
    .find(Boolean);
  if (!url) throw new LauncherError(`GitHub did not report a safe browse URL for port ${port}`);
  return url;
}

export function environmentResult(
  resource,
  ports,
  { appPort, healthPort, healthPath, emitHealth }
) {
  const name = resourceName(resource);
  const result = {
    version: 1,
    access_urls: [{ name: 'App', url: portUrl(resource, ports, appPort) }],
    resource: {
      provider: 'github-codespaces',
      id: name,
      name,
      manage_url: `https://github.com/codespaces/${name}`,
    },
  };
  const healthMetadata = ports.find((item) => item.sourcePort === healthPort);
  const visibility = String(healthMetadata?.visibility ?? '').toLowerCase();
  if (emitHealth === 'always' || (emitHealth === 'public-only' && visibility === 'public')) {
    result.health_url = `${portUrl(resource, ports, healthPort).replace(/\/$/, '')}${healthPath}`;
  }
  return result;
}

export function publicSummary(resource, ports) {
  return {
    codespace: {
      name: resource?.name,
      display_name: resource?.display_name,
      owner: resource?.owner?.login,
      repository: resource?.repository?.full_name,
      ref: resource?.git_status?.ref,
      state: resource?.state,
    },
    ports: ports.map((item) => ({
      sourcePort: item.sourcePort,
      visibility: item.visibility,
      label: item.label,
    })),
  };
}

export function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { help: true };
  }
  const [action, ...rest] = argv;
  if (!['start', 'stop', 'sync', 'nuke', 'health', 'logs'].includes(action)) {
    throw new LauncherError('action must be one of: start, stop, sync, nuke, health, logs');
  }
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new LauncherError(`invalid or missing value for ${key ?? 'argument'}`);
    }
    if (Object.hasOwn(values, key)) throw new LauncherError(`duplicate argument: ${key}`);
    values[key] = value;
  }

  const allowed = new Set([
    '--repository',
    '--ref',
    '--binding',
    '--revision',
    '--devcontainer-path',
    '--idle-timeout-minutes',
    '--retention-period-minutes',
    '--app-port',
    '--health-port',
    '--health-path',
    '--port-visibility',
    '--emit-health',
    '--wait-seconds',
    '--provider-call-timeout',
    '--state-dir',
  ]);
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) throw new LauncherError(`unknown argument: ${key}`);
  }
  for (const key of ['--repository', '--ref', '--binding']) {
    if (!values[key]) throw new LauncherError(`${key} is required`);
  }

  const args = {
    action,
    repository: values['--repository'],
    ref: values['--ref'],
    binding: values['--binding'],
    revision: values['--revision'],
    devcontainerPath:
      values['--devcontainer-path'] ?? '.devcontainer/agor-managed/devcontainer.json',
    idleTimeoutMinutes: integerArgument(values, '--idle-timeout-minutes', 30),
    retentionPeriodMinutes: integerArgument(values, '--retention-period-minutes', 1_440),
    appPort: integerArgument(values, '--app-port', 5_000),
    healthPort: integerArgument(values, '--health-port', 3_000),
    healthPath: values['--health-path'] ?? '/health',
    portVisibility: values['--port-visibility'] ?? 'preserve',
    emitHealth: values['--emit-health'] ?? 'public-only',
    waitSeconds: integerArgument(values, '--wait-seconds', 600),
    providerCallTimeout: integerArgument(values, '--provider-call-timeout', 30),
    stateDir:
      values['--state-dir'] ??
      process.env[STATE_DIR_ENV_VAR] ??
      join(homedir(), '.local', 'state', 'agor', 'codespaces'),
  };

  if (!REPOSITORY_PATTERN.test(args.repository)) {
    throw new LauncherError('--repository must be an owner/repository slug');
  }
  if (!BINDING_PATTERN.test(args.binding)) {
    throw new LauncherError('--binding must be a stable UUID-like identifier');
  }
  if (!args.ref || containsControlCharacter(args.ref) || args.ref.length > 255) {
    throw new LauncherError('--ref must be a non-empty git ref no longer than 255 characters');
  }
  if (args.action === 'sync') {
    if (!args.revision) throw new LauncherError('--revision is required for sync');
    if (!REVISION_PATTERN.test(args.revision)) {
      throw new LauncherError('--revision must be a full lowercase Git SHA-1 or SHA-256 object ID');
    }
  } else if (args.revision !== undefined) {
    throw new LauncherError('--revision is valid only for sync');
  }
  if (!/^\.devcontainer\/[A-Za-z0-9_.-]+\/devcontainer\.json$/.test(args.devcontainerPath)) {
    throw new LauncherError('--devcontainer-path must name one .devcontainer subdirectory');
  }
  assertRange(args.idleTimeoutMinutes, 5, 240, '--idle-timeout-minutes must be between 5 and 240');
  assertRange(
    args.retentionPeriodMinutes,
    0,
    43_200,
    '--retention-period-minutes must be between 0 and 43200'
  );
  assertRange(args.appPort, 1, 65_535, '--app-port must be a valid TCP port');
  assertRange(args.healthPort, 1, 65_535, '--health-port must be a valid TCP port');
  if (
    args.healthPath.length > 1_024 ||
    args.healthPath.startsWith('//') ||
    !HEALTH_PATH_PATTERN.test(args.healthPath)
  ) {
    throw new LauncherError('--health-path must be an absolute URL path without query or fragment');
  }
  if (!['never', 'public-only', 'always'].includes(args.emitHealth)) {
    throw new LauncherError('--emit-health must be one of: never, public-only, always');
  }
  if (!['preserve', 'private', 'org', 'public'].includes(args.portVisibility)) {
    throw new LauncherError('--port-visibility must be one of: preserve, private, org, public');
  }
  assertRange(args.waitSeconds, 30, 1_800, '--wait-seconds must be between 30 and 1800');
  assertRange(
    args.providerCallTimeout,
    5,
    120,
    '--provider-call-timeout must be between 5 and 120'
  );
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write(helpText());
      return 0;
    }
    const store = new StateStore(args.stateDir, args.repository, args.binding);
    const client = new GitHubCodespacesClient({ callTimeout: args.providerCallTimeout });
    const controller = new CodespaceController({ client, store, ...args });

    await store.withLock(async () => {
      if (args.action === 'start') {
        const { resource, ports } = await controller.start();
        process.stdout.write(`${JSON.stringify(publicSummary(resource, ports))}\n`);
        process.stdout.write(
          `${RESULT_PREFIX}${JSON.stringify(
            environmentResult(resource, ports, {
              appPort: args.appPort,
              healthPort: args.healthPort,
              healthPath: args.healthPath,
              emitHealth: args.emitHealth,
            })
          )}\n`
        );
      } else if (args.action === 'stop') {
        const resource = await controller.stop();
        process.stdout.write(resource ? 'Codespace stopped\n' : 'Codespace already absent\n');
      } else if (args.action === 'sync') {
        const appliedRevision = await controller.sync(args.revision);
        process.stdout.write(
          `${RESULT_PREFIX}${JSON.stringify({ version: 1, applied_revision: appliedRevision })}\n`
        );
      } else if (args.action === 'nuke') {
        process.stdout.write(
          (await controller.nuke()) ? 'Codespace deleted\n' : 'Codespace already absent\n'
        );
      } else if (args.action === 'health') {
        const { resource, ports } = await controller.health();
        process.stdout.write(`${JSON.stringify(publicSummary(resource, ports))}\n`);
      } else {
        process.stdout.write(await controller.logs());
      }
    });
    return 0;
  } catch (error) {
    const message = error instanceof LauncherError ? error.message : 'unexpected launcher failure';
    process.stderr.write(`agor-codespaces: ${redact(message)}\n`);
    return 1;
  }
}

function integerArgument(values, key, fallback) {
  const value = values[key];
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new LauncherError(`${key} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new LauncherError(`${key} must be an integer`);
  return parsed;
}

function assertRange(value, minimum, maximum, message) {
  if (value < minimum || value > maximum) throw new LauncherError(message);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function containsControlCharacter(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function helpText() {
  return `Usage: node agor-codespace-launcher.mjs <start|stop|sync|nuke|health|logs> [options]\n\nRequired:\n  --repository OWNER/REPO\n  --ref REF\n  --binding UUID\n\nSync options:\n  --revision FULL_LOWERCASE_GIT_OBJECT_ID\n\nStart options:\n  --port-visibility preserve|private|org|public (default: preserve)\n\nThe launcher uses the authenticated official gh CLI and emits ${RESULT_PREFIX}{...} on Start and Sync.\n`;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) process.exitCode = await main();
