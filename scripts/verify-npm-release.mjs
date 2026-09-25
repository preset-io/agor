#!/usr/bin/env node
// Read-only public release verification. Never authenticates, publishes, or changes tags.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const PACKAGES = [
  '@agor-live/claude',
  '@agor-live/codex',
  '@agor-live/copilot',
  '@agor-live/gemini',
  '@agor-live/opencode',
  '@agor-live/cursor',
  '@agor-live/client',
  'agor-live',
];
const REGISTRY = 'https://registry.npmjs.org';
class IntegrityError extends Error {}

async function digest(stream) {
  const hash = createHash('sha1');
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

export async function artifactHashes(directory, version) {
  return new Map(
    await Promise.all(
      PACKAGES.map(async (name) => {
        const filename = `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;
        return [name, await digest(createReadStream(join(directory, filename)))];
      })
    )
  );
}

export async function verifyRelease({
  version,
  tag,
  packages = PACKAGES,
  expectedHashes,
  timeoutMs = 600_000,
  requestTimeoutMs = 30_000,
  intervalMs = 5_000,
  fetchImpl = fetch,
  now = () => performance.now(),
  wait = sleep,
  log = console.log,
}) {
  for (const value of [timeoutMs, requestTimeoutMs, intervalMs]) {
    if (!Number.isFinite(value) || value <= 0)
      throw new Error('Timeouts must be positive finite numbers');
  }
  if (!version || !tag || !packages.length)
    throw new Error('Version, tag and packages are required');
  if (expectedHashes && packages.some((name) => !expectedHashes.has(name))) {
    throw new Error('Missing validated artifact hash');
  }
  const start = now();
  const deadline = start + timeoutMs;
  const elapsed = () => `${((now() - start) / 1000).toFixed(1)}s`;
  const states = packages.map((name) => ({
    name,
    metadata: null,
    tarball: false,
    tagged: false,
    errors: { metadata: 'not checked', tag: 'not checked', tarball: 'waiting for metadata' },
  }));

  const fatal = new AbortController();
  async function request(url, consume) {
    fatal.signal.throwIfAborted();
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('verification deadline reached');
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('request timed out')),
      Math.min(requestTimeoutMs, remaining)
    );
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.any([controller.signal, fatal.signal]),
        redirect: 'error',
        headers: { 'Cache-Control': 'no-cache' },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      return await consume(response);
    } finally {
      clearTimeout(timer);
    }
  }

  async function stage(state, key, action) {
    try {
      await action();
      delete state.errors[key];
    } catch (error) {
      if (error instanceof IntegrityError) {
        fatal.abort(error);
        throw new IntegrityError(`${error.message} after ${elapsed()}`);
      }
      fatal.signal.throwIfAborted();
      state.errors[key] = error.message;
    }
  }

  while (now() < deadline) {
    await Promise.all(
      states
        .filter((s) => !(s.tarball && s.tagged))
        .map(async (state) => {
          const encoded = encodeURIComponent(state.name);
          if (!state.metadata)
            await stage(state, 'metadata', async () => {
              const metadata = await request(
                `${REGISTRY}/${encoded}/${encodeURIComponent(version)}`,
                (r) => r.json()
              );
              if (metadata.name !== state.name || metadata.version !== version) {
                throw new IntegrityError(
                  `${state.name}: metadata identity mismatch (got ${metadata.name}@${metadata.version})`
                );
              }
              if (!/^[a-f0-9]{40}$/.test(metadata.dist?.shasum ?? '') || !metadata.dist?.tarball) {
                throw new Error('missing dist.shasum or dist.tarball');
              }
              // Same SHA-1 exact-artifact contract as the existing pre-publish guard.
              if (expectedHashes && metadata.dist.shasum !== expectedHashes.get(state.name)) {
                throw new IntegrityError(
                  `${state.name}: metadata shasum differs from validated artifact`
                );
              }
              const url = new URL(metadata.dist.tarball);
              if (url.origin !== REGISTRY || url.username || url.password) {
                throw new IntegrityError(
                  `${state.name}: tarball URL is not on the public registry`
                );
              }
              state.metadata = metadata;
            });
          if (!state.tagged)
            await stage(state, 'tag', async () => {
              const tags = await request(`${REGISTRY}/-/package/${encoded}/dist-tags`, (r) =>
                r.json()
              );
              if (tags[tag] !== version)
                throw new Error(`${tag}=${tags[tag] ?? '<missing>'}; expected ${version}`);
              state.tagged = true;
            });
          if (state.metadata && !state.tarball)
            await stage(state, 'tarball', async () => {
              const hash = await request(state.metadata.dist.tarball, (r) => digest(r.body));
              if (hash !== state.metadata.dist.shasum) {
                throw new IntegrityError(`${state.name}: downloaded tarball shasum mismatch`);
              }
              state.tarball = true;
            });
        })
    );
    const remaining = states.filter((s) => !(s.tarball && s.tagged));
    if (!remaining.length && now() <= deadline) {
      log(
        `Verified ${packages.length} packages @${version}, ${tag}, and tarball bytes after ${elapsed()} (${new Date().toISOString()})`
      );
      return;
    }
    log(
      `After ${elapsed()}, pending: ${remaining
        .map(
          (s) =>
            `${s.name}: ${Object.entries(s.errors)
              .map(([stage, error]) => `${stage}: ${error}`)
              .join('; ')}`
        )
        .join(' | ')}`
    );
    if (now() < deadline) await wait(Math.min(intervalMs, deadline - now()));
  }
  throw new Error(
    `Registry verification timed out after ${elapsed()} (budget ${timeoutMs / 1000}s): ${states
      .filter((s) => !(s.tarball && s.tagged))
      .map((s) => `${s.name}: ${JSON.stringify(s.errors)}`)
      .join(' | ')}`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [version, tag, directory] = process.argv.slice(2);
    if (!directory)
      throw new Error(
        'Usage: node scripts/verify-npm-release.mjs VERSION TAG ARTIFACT_DIR|--registry-only'
      );
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone read-only release script, not a Turbo task
    const timeoutMs = Number(process.env.NPM_VERIFY_TIMEOUT_SECONDS ?? 600) * 1000;
    if (timeoutMs > 1_200_000)
      throw new Error('Maximum verification window is 1200 seconds (workflow headroom)');
    const expectedHashes =
      directory === '--registry-only' ? undefined : await artifactHashes(directory, version);
    await verifyRelease({ version, tag, expectedHashes, timeoutMs });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
