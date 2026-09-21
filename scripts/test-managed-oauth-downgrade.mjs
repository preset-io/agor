#!/usr/bin/env node
/**
 * Actual old compiled daemon startup module against an owned newer PostgreSQL schema.
 * With --old-image, also runs the unmodified published agor-daemon executable/dependencies.
 * With --old-package 0.26.3, runs the integrity-pinned npm executable and frozen dependencies
 * read-only on public Node. This is deliberately not an Agor Docker packaging proof.
 * Without that option the compiled module proof does not establish full entrypoint behavior.
 * No caller database URL is accepted. Run: node scripts/test-managed-oauth-downgrade.mjs
 * Requires Docker and installed workspace dependencies; missing prerequisites FAIL.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { provePublishedOldDaemon, validateOldImage } from './managed-oauth-old-image-proof.mjs';
import {
  OLD_PACKAGE_VERSION,
  preparePublishedOldPackage,
} from './managed-oauth-old-package-proof.mjs';

export const BASELINE_SHA = 'c675abdd306d866860483b6d7289078951f71f37';
export const SCHEMA_SHA = '34676f927ad09f46ad6f1bd7f392a2589d6bdfed';
const EXPECTED_WATERMARK = '1789344000009';
const REFUSAL =
  'Database schema is newer than this Agor binary. Refusing to start because an older daemon cannot safely interpret newer authorization state. Upgrade this binary to match the database.';

export function parseOptions(args) {
  const options = { baseline: BASELINE_SHA, schema: SCHEMA_SHA };
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--old-package') {
      assert.equal(
        args[i + 1],
        OLD_PACKAGE_VERSION,
        'Only the pinned published npm version is accepted'
      );
      options.oldPackage = args[i + 1];
      continue;
    }
    if (args[i] === '--old-image') {
      options.oldImage = validateOldImage(args[i + 1]);
      continue;
    }
    const key = { '--baseline-sha': 'baseline', '--schema-sha': 'schema' }[args[i]];
    if (!key || !/^[a-f0-9]{40}$/.test(args[i + 1] ?? ''))
      throw new Error('Only exact source SHAs and an immutable --old-image digest are accepted');
    options[key] = args[i + 1];
  }
  assert(!(options.oldPackage && options.oldImage), 'Select one published-artifact proof');
  return options;
}

/** Construct, never copy, the child environment. No external DB, provider or npm credentials. */
export function isolatedEnvironment(home) {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    USERPROFILE: home,
    AGOR_DATA_HOME: home,
    AGOR_DB_DIALECT: 'postgresql',
    NODE_ENV: 'test',
  };
}

async function linkInstalledDependencies(source, tree) {
  // External npm dependencies/compiler are reused read-only, not installed using ambient credentials.
  // @agor/core must resolve to the captured source tree's compiled artifact, never the live checkout.
  for (const project of ['', 'packages/core', 'apps/agor-daemon']) {
    const target = join(tree, project, 'node_modules');
    await mkdir(target, { recursive: true });
    for (const name of await readdir(join(source, project, 'node_modules'))) {
      if (name !== '@agor')
        await symlink(join(source, project, 'node_modules', name), join(target, name));
    }
    await mkdir(join(target, '@agor'), { recursive: true });
    await symlink(join(tree, 'packages/core'), join(target, '@agor/core'));
    // These installed dependency packages are imported but their lifecycle is not invoked by startup.
    for (const name of ['git', 'agentic-tools', 'agentic-tool-opencode'])
      await symlink(join(source, 'packages', name), join(target, '@agor', name));
  }
}

async function compileStartup(build, tree) {
  const core = join(tree, 'packages/core');
  const settings = {
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'warning',
  };
  await build({
    ...settings,
    absWorkingDir: core,
    entryPoints: [
      'src/db/index.ts',
      'src/config/index.ts',
      'src/types/index.ts',
      'src/utils/path.ts',
      'src/tracing/datadog.ts',
    ],
    outdir: 'dist',
    outbase: 'src',
  });
  await cp(join(core, 'drizzle'), join(core, 'dist/drizzle'), { recursive: true });
  for (const extension of ['txt', 'LICENSE'])
    await cp(
      join(core, `src/config/password-blocklist-v1.${extension}`),
      join(core, `dist/config/password-blocklist-v1.${extension}`)
    );
  await build({
    ...settings,
    absWorkingDir: join(tree, 'apps/agor-daemon'),
    entryPoints: ['src/setup/database.ts'],
    outdir: 'dist',
    outbase: 'src',
  });
  return settings;
}

async function worker(source, directory, options) {
  const require = createRequire(join(source, 'packages/core/package.json'));
  const { simpleGit } = require('simple-git');
  const compiler = createRequire(require.resolve('tsup'))('esbuild');
  const environment = isolatedEnvironment(join(directory, 'home'));
  const git = (cwd) => simpleGit(cwd).env(environment);
  for (const [name, sha] of [
    ['old', options.baseline],
    ['new', options.schema],
  ]) {
    const tree = join(directory, name);
    // Local object-only clone: no remote fetch, credentials, shared working tree, or ref mutation.
    await git().clone(source, tree, ['--shared', '--no-checkout']);
    await git(tree).checkout(sha);
    assert.equal((await git(tree).revparse(['HEAD'])).trim(), sha);
    await linkInstalledDependencies(source, tree);
  }
  const old = join(directory, 'old');
  const newer = join(directory, 'new');
  await compileStartup(compiler.build, old);
  const settings = await compileStartup(compiler.build, newer);
  await compiler.build({
    ...settings,
    absWorkingDir: join(newer, 'packages/core'),
    entryPoints: ['src/db/test-support/owned-postgres.ts'],
    outfile: 'dist/db/test-support/owned-postgres.mjs',
  });
  const { createOwnedPostgres, assertNonOwnerPostgres } = await import(
    pathToFileURL(join(newer, 'packages/core/dist/db/test-support/owned-postgres.mjs')).href
  );
  let owned;
  let stage = 'owned-schema';
  try {
    // The pinned harness creates its own cluster and checks run/container identity before cleanup.
    owned = await createOwnedPostgres();
    stage = 'non-owner-role';
    await assertNonOwnerPostgres(owned.sql);
    stage = 'schema-watermark';
    const [row] =
      await owned.sql`SELECT MAX(created_at)::text AS watermark FROM drizzle.__drizzle_migrations`;
    assert.equal(row.watermark, EXPECTED_WATERMARK);
    const journal = JSON.parse(
      await readFile(join(old, 'packages/core/drizzle/postgres/meta/_journal.json'), 'utf8')
    );
    assert(BigInt(journal.entries.at(-1).when) < BigInt(row.watermark));
    const before = await owned.sql`SELECT (SELECT count(*)::text FROM users) AS users,
      (SELECT count(*)::text FROM user_mcp_oauth_tokens) AS grants,
      (SELECT count(*)::text FROM mcp_oauth_pending_flows) AS attempts`;
    // Only this freshly generated fixture login is passed. Never read an ambient DATABASE_URL.
    const o = owned.sql.options;
    const databaseUrl = `postgresql://${encodeURIComponent(o.user)}:${encodeURIComponent(o.pass ?? o.password)}@${o.host[0]}:${o.port[0]}/${o.database}`;
    const moduleUrl = pathToFileURL(join(old, 'apps/agor-daemon/dist/setup/database.js')).href;
    stage = 'compiled-old-startup';
    const program = `
      import { initializeDatabase } from ${JSON.stringify(moduleUrl)};
      let requests = 0;
      globalThis.fetch = async () => { requests++; throw new Error('HTTP forbidden'); };
      try {
        await initializeDatabase(process.env.TEST_DATABASE_URL, { traceServices: 'off' });
        process.exit(1);
      } catch (error) {
        if (error?.message !== ${JSON.stringify(REFUSAL)} || requests !== 0) process.exit(2);
        console.log('EXPECTED_OLD_STARTUP_REFUSAL');
        console.log(error.message);
        console.log('HTTP_PROVIDER_REQUEST_COUNT=0');
        process.exit(42);
      }`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
      cwd: old,
      env: {
        ...environment,
        TEST_DATABASE_URL: databaseUrl,
        AGOR_MASTER_SECRET: 'synthetic-old-binary-proof-only',
      },
      encoding: 'utf8',
      timeout: 30000,
    });
    if (result.status !== 42 || result.stderr !== '') {
      // Do not dump subprocess output: an unexpected startup may include its
      // generated DB URL. Codes/booleans identify missing CI prerequisites safely.
      console.error(
        JSON.stringify({
          stage: 'compiled-old-startup',
          status: result.status,
          signaled: result.signal !== null,
          missing_module: /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(result.stderr ?? ''),
          timed_out: result.error?.code === 'ETIMEDOUT',
          stderr_present: Boolean(result.stderr),
        })
      );
    }
    assert.equal(result.status, 42, 'Actual old startup must reject the newer schema');
    assert.match(result.stdout, /EXPECTED_OLD_STARTUP_REFUSAL/);
    assert.doesNotMatch(result.stdout, /Database ready|Seeding initial data/);
    assert.equal(result.stderr, '');
    stage = options.oldPackage ? 'published-old-package' : 'published-old-image';
    const publishedPackage = options.oldPackage
      ? await preparePublishedOldPackage(directory, environment)
      : undefined;
    const publishedArtifact =
      options.oldImage || publishedPackage
        ? await provePublishedOldDaemon({
            image: options.oldImage,
            baseline: options.baseline,
            owned,
            directory,
            environment,
            publishedPackage,
          })
        : undefined;
    stage = 'unchanged-state';
    const after = await owned.sql`SELECT (SELECT count(*)::text FROM users) AS users,
      (SELECT count(*)::text FROM user_mcp_oauth_tokens) AS grants,
      (SELECT count(*)::text FROM mcp_oauth_pending_flows) AS attempts`;
    assert.deepEqual(after, before);
    assert.deepEqual(after[0], { users: '0', grants: '0', attempts: '0' });
    const hashes = {};
    for (const file of [
      'old/apps/agor-daemon/src/setup/database.ts',
      'old/apps/agor-daemon/dist/setup/database.js',
      'old/packages/core/src/db/migrate.ts',
      'old/packages/core/dist/db/index.js',
      'old/packages/core/drizzle/postgres/meta/_journal.json',
      'new/packages/core/drizzle/postgres/meta/_journal.json',
    ])
      hashes[file] = createHash('sha256')
        .update(await readFile(join(directory, file)))
        .digest('hex');
    console.log(result.stdout.trim());
    console.log(
      JSON.stringify(
        {
          result: 'passed',
          baseline_sha: options.baseline,
          schema_sha: options.schema,
          watermark: row.watermark,
          compiler: `esbuild ${compiler.version}`,
          hashes,
          scope:
            'actual compiled old startup module; NOT full daemon entrypoint or published image',
          dependencies:
            'installed npm/compiler and unused workspace dependency packages reused read-only',
          rows_unchanged: true,
          http_requests: 0,
          ...(publishedArtifact
            ? {
                [publishedPackage ? 'published_package_proof' : 'published_image_proof']:
                  publishedArtifact,
              }
            : {}),
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(JSON.stringify({ stage, assertion: error?.code === 'ERR_ASSERTION' }));
    throw error;
  } finally {
    await owned?.dispose();
    console.log('Owned PostgreSQL cluster disposed');
  }
}

export async function main(args) {
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (args[0] === '--isolated-worker') {
    const directory = args[1];
    assert(directory?.startsWith(join(tmpdir(), 'agor-managed-downgrade-')));
    await worker(source, directory, parseOptions(args.slice(2)));
    return;
  }
  parseOptions(args);
  const directory = await mkdtemp(join(tmpdir(), 'agor-managed-downgrade-'));
  try {
    await mkdir(join(directory, 'home'));
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), '--isolated-worker', directory, ...args],
      {
        env: isolatedEnvironment(join(directory, 'home')),
        stdio: 'inherit',
      }
    );
    assert.equal(result.status, 0, 'Downgrade acceptance failed (no skip permitted)');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(() => {
    console.error('FAIL: managed downgrade startup acceptance; inspect the test failure above.');
    process.exitCode = 1;
  });
