import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const migrationScript = join(scriptsDir, 'strict-to-sandbox-migration.sh');
const preflightScript = join(scriptsDir, 'sandbox-home-migration-preflight.sh');
const hasSqlite = spawnSync('sqlite3', ['--version']).status === 0;
const hasUserNamespace = spawnSync('unshare', ['-Ur', 'true']).status === 0;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agor-sandbox-migration-'));
  const dataHome = join(root, 'data');
  const config = join(dataHome, 'config.yaml');
  await mkdir(dataHome, { recursive: true });
  await writeFile(config, 'execution:\n  unix_user_mode: strict\n');
  return { root, dataHome, config };
}

function runMigration(args, env = {}) {
  return spawnSync(migrationScript, args, {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: '', ...env },
  });
}

test('SQLite dry-run resolves only the requested tenant without mutating state', {
  skip: !hasSqlite,
}, async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const db = join(f.dataHome, 'agor.db');
  execFileSync('sqlite3', [
    db,
    "CREATE TABLE users (tenant_id text, user_id text, unix_username text, filesystem_home text); INSERT INTO users VALUES ('default', 'user-1', 'root', NULL), ('other', 'user-2', 'nobody', NULL);",
  ]);

  const result = runMigration([
    '--data-home',
    f.dataHome,
    '--config',
    f.config,
    '--daemon-user',
    process.env.USER ?? 'root',
    '--expected-user-count',
    '1',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /database\s+: sqlite/);
  assert.match(result.stdout, /would update 1 rows in one sqlite transaction/);
  assert.equal(await readFile(f.config, 'utf8'), 'execution:\n  unix_user_mode: strict\n');
  await assert.rejects(readFile(join(f.dataHome, 'ownership-manifest-pre-sandbox.tsv.gz')));
});

test('dry-run fails closed when filesystem_home migration is absent', {
  skip: !hasSqlite,
}, async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  execFileSync('sqlite3', [
    join(f.dataHome, 'agor.db'),
    'CREATE TABLE users (tenant_id text, user_id text, unix_username text);',
  ]);

  const result = runMigration([
    '--data-home',
    f.dataHome,
    '--config',
    f.config,
    '--daemon-user',
    process.env.USER ?? 'root',
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /users\.filesystem_home is missing/);
});

test('dry-run resolves symlinked passwd homes to canonical mutation roots', {
  skip: !hasSqlite,
}, async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const db = join(f.dataHome, 'agor.db');
  const canonicalHome = join(f.root, 'canonical-home');
  const passwdHome = join(f.root, 'passwd-home');
  const bin = join(f.root, 'bin');
  await mkdir(canonicalHome);
  await symlink(canonicalHome, passwdHome);
  await mkdir(bin);
  execFileSync('sqlite3', [
    db,
    "CREATE TABLE users (tenant_id text, user_id text, unix_username text, filesystem_home text); INSERT INTO users VALUES ('default', 'user-1', 'fixture-user', NULL);",
  ]);
  const fakeGetent = join(bin, 'getent');
  await writeFile(
    fakeGetent,
    `#!/usr/bin/env bash
if [ "$*" = 'passwd fixture-user' ]; then
  echo 'fixture-user:x:1234:1234:Fixture:${passwdHome}:/bin/bash'
else
  exec /usr/bin/getent "$@"
fi
`
  );
  await chmod(fakeGetent, 0o755);

  const result = runMigration(
    [
      '--data-home',
      f.dataHome,
      '--config',
      f.config,
      '--daemon-user',
      process.env.USER ?? 'root',
      '--expected-user-count',
      '1',
    ],
    { PATH: `${bin}:${process.env.PATH}` }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`canonical: ${canonicalHome.replaceAll('/', '\\/')}`));
});

test('prepare-only freezes restartable owner-only units without changing DB or config', {
  skip: !hasSqlite || !hasUserNamespace,
}, async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const db = join(f.dataHome, 'agor.db');
  const canonicalHome = join(f.root, 'canonical-home');
  const passwdHome = join(f.root, 'passwd-home');
  const repo = join(f.dataHome, 'repos', 'repo-a');
  const worktreeBucket = join(f.dataHome, 'worktrees', 'owner-a', 'repo-a');
  const branch = join(worktreeBucket, 'branch-a');
  const bin = join(f.root, 'bin');
  const findLog = join(f.root, 'find.log');
  await mkdir(canonicalHome);
  await symlink(canonicalHome, passwdHome);
  await mkdir(repo, { recursive: true });
  await mkdir(branch, { recursive: true });
  await mkdir(bin);
  execFileSync('sqlite3', [
    db,
    "CREATE TABLE users (tenant_id text, user_id text, unix_username text, filesystem_home text); INSERT INTO users VALUES ('default', 'user-1', 'fixture-user', NULL);",
  ]);
  await writeFile(
    join(bin, 'getent'),
    `#!/usr/bin/env bash
if [ "$*" = 'passwd fixture-user' ]; then
  echo 'fixture-user:x:1234:1234:Fixture:${passwdHome}:/bin/bash'
else
  exec /usr/bin/getent "$@"
fi
`
  );
  await writeFile(
    join(bin, 'find'),
    `#!/usr/bin/env bash
printf '%q ' "$@" >> "$FIND_LOG"
printf '\n' >> "$FIND_LOG"
exec /usr/bin/find "$@"
`
  );
  await chmod(join(bin, 'getent'), 0o755);
  await chmod(join(bin, 'find'), 0o755);

  const baseArgs = [
    '--data-home',
    f.dataHome,
    '--config',
    f.config,
    '--daemon-user',
    'root',
    '--expected-user-count',
    '1',
    '--service-name',
    'agor-migration-test-nonexistent',
  ];
  const env = {
    ...process.env,
    DATABASE_URL: '',
    PATH: `${bin}:${process.env.PATH}`,
    FIND_LOG: findLog,
  };
  const prepared = spawnSync('unshare', ['-Ur', migrationScript, '--prepare-only', ...baseArgs], {
    encoding: 'utf8',
    env,
  });

  assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(prepared.stdout, /PREPARED; no database, ownership, or mode mutation/);
  assert.equal(await readFile(f.config, 'utf8'), 'execution:\n  unix_user_mode: strict\n');
  assert.equal(
    execFileSync('sqlite3', [db, "SELECT coalesce(filesystem_home, '') FROM users;"], {
      encoding: 'utf8',
    }).trim(),
    ''
  );

  const manifest = join(f.dataHome, 'ownership-manifest-pre-sandbox.tsv.gz');
  const planPath = `${manifest}.ownership-plan`;
  const progressPath = `${manifest}.ownership-progress`;
  execFileSync('gzip', ['-t', manifest]);
  const plan = await readFile(planPath, 'utf8');
  assert.match(plan, new RegExp(`tree\\|0\\|${repo.replaceAll('/', '\\/')}`));
  assert.match(plan, new RegExp(`tree\\|0\\|${worktreeBucket.replaceAll('/', '\\/')}`));
  assert.doesNotMatch(plan, new RegExp(`tree\\|0\\|${branch.replaceAll('/', '\\/')}`));

  const unexpectedRepo = join(f.dataHome, 'repos', 'repo-added-after-prepare');
  await mkdir(unexpectedRepo);
  const rejected = spawnSync(
    'unshare',
    ['-Ur', migrationScript, '--apply', '--resume', ...baseArgs],
    { encoding: 'utf8', env }
  );
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /ownership roots differ from the preserved plan/);
  assert.equal(
    execFileSync('sqlite3', [db, "SELECT coalesce(filesystem_home, '') FROM users;"], {
      encoding: 'utf8',
    }).trim(),
    ''
  );
  await rm(unexpectedRepo, { recursive: true });

  await writeFile(progressPath, `${await readFile(progressPath, 'utf8')}done=000001\n`);
  const applied = spawnSync(
    'unshare',
    ['-Ur', migrationScript, '--apply', '--resume', ...baseArgs],
    { encoding: 'utf8', env }
  );

  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /\[000001\/\d+\] already complete; skipping/);
  assert.equal(await readFile(f.config, 'utf8'), 'execution:\n  unix_user_mode: sandbox\n');
  const findInvocations = await readFile(findLog, 'utf8');
  assert.match(findInvocations, /-exec chown -h -- root/);
  assert.doesNotMatch(findInvocations, /root:root/);
});

test('SQLite apply completes transaction, manifest, ownership walk, and config flip', {
  skip: !hasSqlite || !hasUserNamespace,
}, async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const db = join(f.dataHome, 'agor.db');
  const canonicalHome = join(f.root, 'canonical-home');
  const passwdHome = join(f.root, 'passwd-home');
  const bin = join(f.root, 'bin');
  await mkdir(canonicalHome);
  await writeFile(join(canonicalHome, 'state.txt'), 'state');
  await symlink(canonicalHome, passwdHome);
  await mkdir(bin);
  execFileSync('sqlite3', [
    db,
    "CREATE TABLE users (tenant_id text, user_id text, unix_username text, filesystem_home text); INSERT INTO users VALUES ('default', 'user-1', 'fixture-user', NULL);",
  ]);
  const fakeGetent = join(bin, 'getent');
  await writeFile(
    fakeGetent,
    `#!/usr/bin/env bash
if [ "$*" = 'passwd fixture-user' ]; then
  echo 'fixture-user:x:1234:1234:Fixture:${passwdHome}:/bin/bash'
else
  exec /usr/bin/getent "$@"
fi
`
  );
  await chmod(fakeGetent, 0o755);

  const result = spawnSync(
    'unshare',
    [
      '-Ur',
      migrationScript,
      '--apply',
      '--data-home',
      f.dataHome,
      '--config',
      f.config,
      '--daemon-user',
      'root',
      '--expected-user-count',
      '1',
      '--service-name',
      'agor-migration-test-nonexistent',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: '', PATH: `${bin}:${process.env.PATH}` },
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(f.config, 'utf8'), 'execution:\n  unix_user_mode: sandbox\n');
  assert.equal(
    await readFile(`${f.config}.pre-sandbox`, 'utf8'),
    'execution:\n  unix_user_mode: strict\n'
  );
  assert.equal(
    execFileSync('sqlite3', [db, "SELECT filesystem_home FROM users WHERE user_id = 'user-1';"], {
      encoding: 'utf8',
    }).trim(),
    passwdHome
  );
  const manifest = join(f.dataHome, 'ownership-manifest-pre-sandbox.tsv.gz');
  execFileSync('gzip', ['-t', manifest]);
  const manifestContent = execFileSync('gzip', ['-dc', manifest]);
  assert.equal(manifestContent.includes(Buffer.from(`${canonicalHome}/state.txt\0`)), true);
});

test('PostgreSQL apply sends one verified mapping transaction before the config flip', {
  skip: !hasUserNamespace,
}, async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const canonicalHome = join(f.root, 'canonical-home');
  const passwdHome = join(f.root, 'passwd-home');
  const marker = join(f.root, 'postgres-apply-checked');
  const bin = join(f.root, 'bin');
  await mkdir(canonicalHome);
  await symlink(canonicalHome, passwdHome);
  await mkdir(bin);
  const fakeGetent = join(bin, 'getent');
  await writeFile(
    fakeGetent,
    `#!/usr/bin/env bash
if [ "$*" = 'passwd fixture-user' ]; then
  echo 'fixture-user:x:1234:1234:Fixture:${passwdHome}:/bin/bash'
else
  exec /usr/bin/getent "$@"
fi
`
  );
  await chmod(fakeGetent, 0o755);
  const fakePsql = join(bin, 'psql');
  await writeFile(
    fakePsql,
    `#!/usr/bin/env bash
[[ "$*" != *topsecret* ]] || exit 9
[[ "$PGPASSWORD" = topsecret ]] || exit 9
input="$(cat)"
case "$* $input" in
  *information_schema.columns*) echo t ;;
  *"SELECT tenant_id::text"*) echo 'default|user-1|fixture-user' ;;
  *" -f "*)
    sql_file="\${@: -1}"
    /usr/bin/grep -q '^BEGIN;$' "$sql_file" || exit 8
    /usr/bin/grep -q 'CREATE TEMP TABLE agor_sandbox_home_map' "$sql_file" || exit 8
    /usr/bin/grep -q "${passwdHome}" "$sql_file" || exit 8
    /usr/bin/grep -q 'filesystem_home verification failed' "$sql_file" || exit 8
    /usr/bin/grep -q '^COMMIT;$' "$sql_file" || exit 8
    printf checked > "$PSQL_APPLY_MARKER"
    ;;
  *) echo "unexpected psql invocation: $*" >&2; exit 2 ;;
esac
`
  );
  await chmod(fakePsql, 0o755);

  const result = spawnSync(
    'unshare',
    [
      '-Ur',
      migrationScript,
      '--apply',
      '--data-home',
      f.dataHome,
      '--config',
      f.config,
      '--daemon-user',
      'root',
      '--database-url',
      'postgresql://user:topsecret@example.invalid/agor',
      '--tenant-id',
      'default',
      '--expected-user-count',
      '1',
      '--service-name',
      'agor-migration-test-nonexistent',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: '',
        PATH: `${bin}:${process.env.PATH}`,
        PSQL_APPLY_MARKER: marker,
      },
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(marker, 'utf8'), 'checked');
  assert.equal(await readFile(f.config, 'utf8'), 'execution:\n  unix_user_mode: sandbox\n');
  execFileSync('gzip', ['-t', join(f.dataHome, 'ownership-manifest-pre-sandbox.tsv.gz')]);
});

test('PostgreSQL dry-run uses the tenant-scoped visible user set', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const bin = join(f.root, 'bin');
  await mkdir(bin, { recursive: true });
  const fakePsql = join(bin, 'psql');
  await writeFile(
    fakePsql,
    `#!/usr/bin/env bash
[[ "$*" != *topsecret* ]] || { echo 'password leaked in argv' >&2; exit 9; }
[[ "$PGPASSWORD" = topsecret ]] || { echo 'password not passed through PGPASSWORD' >&2; exit 9; }
input="$(cat)"
case "$* $input" in
  *information_schema.columns*) echo t ;;
  *"SELECT tenant_id::text"*) echo 'default|user-1|root' ;;
  *) echo "unexpected psql invocation: $*" >&2; exit 2 ;;
esac
`
  );
  await chmod(fakePsql, 0o755);

  const result = runMigration(
    [
      '--data-home',
      f.dataHome,
      '--config',
      f.config,
      '--daemon-user',
      process.env.USER ?? 'root',
      '--database-url',
      'postgresql://user:topsecret@example.invalid/agor',
      '--tenant-id',
      'default',
      '--expected-user-count',
      '1',
    ],
    { PATH: `${bin}:${process.env.PATH}` }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /database\s+: postgres/);
  assert.match(result.stdout, /would update 1 rows in one postgres transaction/);
});

test('PostgreSQL dry-run fails if psql exits after partial user output', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const bin = join(f.root, 'bin');
  await mkdir(bin, { recursive: true });
  const fakePsql = join(bin, 'psql');
  await writeFile(
    fakePsql,
    `#!/usr/bin/env bash
[[ "$*" != *topsecret* ]] || exit 9
[[ "$PGPASSWORD" = topsecret ]] || exit 9
input="$(cat)"
case "$* $input" in
  *information_schema.columns*) echo t ;;
  *"SELECT tenant_id::text"*) echo 'default|user-1|root'; exit 3 ;;
  *) exit 2 ;;
esac
`
  );
  await chmod(fakePsql, 0o755);

  const result = runMigration(
    [
      '--data-home',
      f.dataHome,
      '--config',
      f.config,
      '--daemon-user',
      process.env.USER ?? 'root',
      '--database-url',
      'postgresql://user:topsecret@example.invalid/agor',
    ],
    { PATH: `${bin}:${process.env.PATH}` }
  );

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /would update/);
});

test('preflight treats references in the stable daemon home as review-only', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agor-sandbox-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsDir = join(root, '.claude');
  await mkdir(settingsDir, { recursive: true });
  await writeFile(join(settingsDir, 'settings.local.json'), JSON.stringify({ path: root }));

  const stable = spawnSync(preflightScript, [root, '--stable-home', root], { encoding: 'utf8' });
  assert.equal(stable.status, 0, stable.stderr);
  assert.match(stable.stdout, /review \(stable daemon home\)/);

  const blocking = spawnSync(preflightScript, [root], { encoding: 'utf8' });
  assert.notEqual(blocking.status, 0);
  assert.match(blocking.stdout, /BLOCKER/);
});

test('preflight fails closed when a credential file cannot be scanned', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agor-sandbox-preflight-error-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsDir = join(root, '.claude');
  const bin = join(root, 'bin');
  await mkdir(settingsDir, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(settingsDir, 'settings.json'), '{}');
  const fakeGrep = join(bin, 'grep');
  await writeFile(fakeGrep, '#!/usr/bin/env bash\nexit 2\n');
  await chmod(fakeGrep, 0o755);

  const result = spawnSync(preflightScript, [root], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not scan/);
});

test('preflight checks the canonical target of a symlinked home', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agor-sandbox-preflight-symlink-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonicalHome = join(root, 'canonical-home');
  const passwdHome = join(root, 'passwd-home');
  const settingsDir = join(canonicalHome, '.claude');
  await mkdir(settingsDir, { recursive: true });
  await symlink(canonicalHome, passwdHome);
  await writeFile(join(settingsDir, 'settings.json'), JSON.stringify({ path: canonicalHome }));

  const stable = spawnSync(preflightScript, [passwdHome, '--stable-home', passwdHome], {
    encoding: 'utf8',
  });
  assert.equal(stable.status, 0, stable.stderr);
  assert.match(stable.stdout, new RegExp(`review.*${canonicalHome.replaceAll('/', '\\/')}`));

  const blocking = spawnSync(preflightScript, [passwdHome], { encoding: 'utf8' });
  assert.notEqual(blocking.status, 0);
  assert.match(blocking.stdout, new RegExp(`BLOCKER.*${canonicalHome.replaceAll('/', '\\/')}`));
});
