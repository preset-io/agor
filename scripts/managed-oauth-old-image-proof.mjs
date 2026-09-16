/** Test-only published daemon proof. No external database or mutable image is accepted. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const command = promisify(execFile);
const label = 'agor.managed-old-image';

export function validateOldImage(image) {
  if (!/^docker\.io\/preset\/agor@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error('Old image must be an immutable docker.io/preset/agor digest');
  return image;
}

export function publishedImageEnvironment(options) {
  // options comes only from createOwnedPostgres(), never caller/environment configuration.
  assert.match(options.user, /^runtime_[a-f0-9]{32}$/);
  assert.equal(options.database, 'agor');
  return {
    DATABASE_URL: `postgresql://${encodeURIComponent(options.user)}:${encodeURIComponent(options.pass ?? options.password)}@owned-postgres:5432/agor`,
    AGOR_DB_DIALECT: 'postgresql',
    AGOR_CONFIG_PATH: '/home/agor/config.yaml',
    AGOR_TELEMETRY: '0',
    AGOR_JWT_SECRET: 'synthetic-downgrade-jwt-012345678901234567890123456789',
    AGOR_MASTER_SECRET: 'synthetic-downgrade-master-012345678901234567890123456789',
  };
}

export async function provePublishedOldDaemon({ image, baseline, owned, directory, environment }) {
  validateOldImage(image);
  const run = randomUUID();
  const docker = async (args) => {
    try {
      return await command('docker', args, {
        env: environment,
        timeout: 120000,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      // Only fixed operation and classified availability, never raw Docker
      // diagnostics, command arguments, container logs or generated credentials.
      const message = String(error?.stderr ?? '');
      console.error(
        JSON.stringify({
          stage: 'published-old-docker',
          operation: args[0],
          rate_limited: /toomanyrequests|pull rate limit/i.test(message),
          authorization_denied: /unauthorized|denied/i.test(message),
          missing_manifest: /manifest unknown|no matching manifest/i.test(message),
          unavailable:
            error?.code === 'ENOENT' || /Cannot connect to the Docker daemon/i.test(message),
          timed_out: error?.killed === true,
        })
      );
      throw error;
    }
  };
  // Pull the exact public digest; no caller registry or credential file is inherited.
  await docker(['pull', image]);
  const revision = await docker([
    'image',
    'inspect',
    '--format',
    '{{index .Config.Labels "org.opencontainers.image.revision"}}',
    image,
  ]);
  assert.equal(revision.stdout.trim(), baseline, 'Published image must match the old source pin');
  const options = owned.sql.options;
  const env = publishedImageEnvironment(options);
  const pgRun = options.user.slice('runtime_'.length);
  const lookup = await docker([
    'ps',
    '--no-trunc',
    '--filter',
    `label=agor.managed-oauth-test-run=${pgRun}`,
    '--format',
    '{{.ID}}',
  ]);
  const pg = lookup.stdout.trim();
  assert.match(pg, /^[a-f0-9]{64}$/, 'Exactly the run-owned PostgreSQL container is required');
  let network;
  let connected = false;
  let container;
  const assertOwned = async (kind, id) => {
    const result = await docker([
      kind,
      'inspect',
      '--format',
      `{{index ${kind === 'container' ? '.Config.Labels' : '.Labels'} "${label}"}}`,
      id,
    ]);
    assert.equal(result.stdout.trim(), run, 'Refusing cleanup of an unowned Docker object');
  };
  try {
    network = (
      await docker([
        'network',
        'create',
        '--internal',
        '--label',
        `${label}=${run}`,
        `managed-old-${run}`,
      ])
    ).stdout.trim();
    assert.match(network, /^[a-f0-9]{64}$/);
    assert.equal(
      (await docker(['network', 'inspect', '--format', '{{.Internal}}', network])).stdout.trim(),
      'true'
    );
    await docker(['network', 'connect', '--alias', 'owned-postgres', network, pg]);
    connected = true;
    const config = join(directory, 'published-old-config.yaml');
    const envFile = join(directory, 'published-old.env');
    await writeFile(
      config,
      `daemon:\n  deployment_id: ${run}\ntelemetry:\n  enabled: false\nagentic_tools:\n  installed: []\n`,
      { mode: 0o644 }
    );
    await writeFile(
      envFile,
      `${Object.entries(env)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`,
      { mode: 0o600 }
    );
    // Run the published PostgreSQL daemon command, not the image's SQLite init wrapper.
    // Only a synthetic operator config is copied; compiled application/dependencies stay untouched.
    container = (
      await docker([
        'create',
        '--network',
        network,
        '--label',
        `${label}=${run}`,
        '--tmpfs',
        '/tmp:rw,nosuid,nodev',
        '--tmpfs',
        '/home/agor/.agor:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700',
        '--entrypoint',
        'agor-daemon',
        '--env-file',
        envFile,
        image,
      ])
    ).stdout.trim();
    assert.match(container, /^[a-f0-9]{64}$/);
    await docker(['cp', config, `${container}:/home/agor/config.yaml`]);
    await docker(['start', container]);
    const stopped = await docker(['wait', container]);
    const logs = await docker(['logs', container]);
    assert.equal(stopped.stdout.trim(), '1', 'Old published daemon must exit before serving');
    // Do not emit arbitrary daemon logs, generated credentials, or a connection URL.
    const output = logs.stdout + logs.stderr;
    assert(output.includes('Database schema is newer than this Agor binary. Refusing to start'));
    assert(!/Database migrations up to date|Seeding initial data|listening on/i.test(output));
    return {
      image,
      revision: baseline,
      entrypoint: 'agor-daemon',
      exit_code: 1,
      network: 'run-owned internal network; no published daemon ports or external egress',
      application:
        'unmodified published executable and dependencies; synthetic operator configuration only',
    };
  } finally {
    if (container) {
      await assertOwned('container', container);
      await docker(['rm', '--force', '--volumes', container]);
    }
    if (network) {
      await assertOwned('network', network);
      if (connected) await docker(['network', 'disconnect', network, pg]);
      await docker(['network', 'rm', network]);
    }
  }
}
