import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Match the dependency inputs copied by development plus runtime-build.
export async function dependencyFingerprint(root) {
  const files = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
  for (const workspace of [
    'apps/agor-daemon',
    'apps/agor-cli',
    'apps/agor-ui',
    'packages/git',
    'packages/core',
    'packages/agentic-tool-opencode',
    'packages/agentic-tools',
    'packages/executor',
    'packages/client',
    'packages/agor-live',
    'packages/agor-claude',
    'packages/agor-codex',
    'packages/agor-copilot',
    'packages/agor-gemini',
    'packages/agor-opencode',
    'packages/agor-cursor',
  ]) {
    files.push(`${workspace}/package.json`);
  }
  for (const name of (await readdir(join(root, 'patches'))).sort()) files.push(`patches/${name}`);
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    hash
      .update(file)
      .update('\0')
      .update(await readFile(join(root, file)))
      .update('\0');
  }
  return hash.digest('hex');
}

export function validateSource(repo, branch) {
  // Initial prototype intentionally supports this public repo only. Never send
  // provider credentials to an arbitrary clone URL supplied by a branch.
  if (repo !== 'https://github.com/preset-io/agor.git')
    throw new Error('Unsupported runtime source repository');
  if (
    !branch ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) ||
    branch.includes('..') ||
    branch.endsWith('/') ||
    branch.includes('//')
  ) {
    throw new Error('Invalid runtime source branch');
  }
}

export async function prepareCheckout({ state, repo, branch, git, expectedFingerprint }) {
  validateSource(repo, branch);
  await mkdir(state, { recursive: true, mode: 0o700 });
  const checkout = join(state, 'checkout');
  const marker = join(state, 'source-owner.json');
  const owner = JSON.stringify({ version: 1, repo, branch });
  let exists = false;
  try {
    await lstat(checkout);
    exists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (exists) {
    if ((await lstat(checkout)).isSymbolicLink() || (await readFile(marker, 'utf8')) !== owner) {
      throw new Error('Refusing to modify an unowned runtime checkout');
    }
    if ((await git(checkout).remote(['get-url', 'origin'])).trim() !== repo) {
      throw new Error('Runtime checkout origin mismatch');
    }
    await git(checkout).fetch('origin', branch, ['--depth=1', '--no-tags']);
    await git(checkout).reset(['--hard', 'FETCH_HEAD']);
  } else {
    // The shell holds the state lock. A failed clone must not strand a partial
    // checkout that could later be mistaken for a completed owned repository.
    const staging = join(state, 'checkout-staging');
    try {
      await git().clone(repo, staging, ['--depth=1', '--single-branch', '--branch', branch]);
      await writeFile(marker, owner, { mode: 0o600 });
      await rename(staging, checkout);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  if ((await dependencyFingerprint(checkout)) !== expectedFingerprint) {
    throw new Error(
      'Source dependencies differ from the image; rebuild the dependency image before starting'
    );
  }
  return { checkout, sha: (await git(checkout).revparse(['HEAD'])).trim() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === 'fingerprint') {
      console.log(await dependencyFingerprint('/app'));
    } else {
      const require = createRequire('/app/packages/git/package.json');
      const { simpleGit } = require('simple-git');
      const result = await prepareCheckout({
        // biome-ignore lint/suspicious/noUndeclaredEnvVars: container startup, not a Turbo task.
        state: process.env.AGOR_RUNTIME_STATE,
        // biome-ignore lint/suspicious/noUndeclaredEnvVars: container startup, not a Turbo task.
        repo: process.env.AGOR_SOURCE_REPO,
        // biome-ignore lint/suspicious/noUndeclaredEnvVars: container startup, not a Turbo task.
        branch: process.env.AGOR_SOURCE_BRANCH,
        git: simpleGit,
        expectedFingerprint: (await readFile('/opt/agor-dependency-fingerprint', 'utf8')).trim(),
      });
      console.log(result.sha);
    }
  } catch {
    // Git errors can echo remote credentials/configuration. Keep diagnostics generic.
    console.error(
      'Runtime checkout preparation failed (source ownership, fetch, or dependency mismatch).'
    );
    process.exitCode = 1;
  }
}
