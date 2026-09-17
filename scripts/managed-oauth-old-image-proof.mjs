/** Test-only published daemon proof. No external database or mutable image is accepted. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PACKAGE_NODE_IMAGE } from './managed-oauth-old-package-proof.mjs';

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

export async function provePublishedOldDaemon({
  image,
  baseline,
  owned,
  directory,
  environment,
  publishedPackage,
}) {
  if (publishedPackage) {
    assert.equal(publishedPackage.directory, join(directory, 'published-package'));
    image = PACKAGE_NODE_IMAGE;
  } else validateOldImage(image);
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
  // Pull the exact digest; no caller registry or credential file is inherited.
  // Registry access is a prerequisite, not evidence that this image is anonymous/public.
  await docker(['pull', image]);
  const revision = publishedPackage
    ? publishedPackage.revision
    : (
        await docker([
          'image',
          'inspect',
          '--format',
          '{{index .Config.Labels "org.opencontainers.image.revision"}}',
          image,
        ])
      ).stdout.trim();
  if (!publishedPackage)
    assert.equal(revision, baseline, 'Published image must match the old source pin');
  const options = owned.sql.options;
  const env = publishedImageEnvironment(options);
  const home = publishedPackage ? '/home/node' : '/home/agor';
  env.AGOR_CONFIG_PATH = publishedPackage
    ? '/opt/published-package/operator-config.yaml'
    : `${home}/config.yaml`;
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
  let packageVolume;
  let stagingContainer;
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
    if (publishedPackage) {
      // Docker may be remote from the test client: populate a labeled volume
      // through a never-started, network-none staging container, not a host bind.
      packageVolume = (
        await docker(['volume', 'create', '--label', `${label}=${run}`])
      ).stdout.trim();
      assert.match(packageVolume, /^[a-f0-9]{64}$/);
      stagingContainer = (
        await docker([
          'create',
          '--network',
          'none',
          '--label',
          `${label}=${run}`,
          '--mount',
          `type=volume,src=${packageVolume},dst=/opt/published-package`,
          image,
          'node',
          '--version',
        ])
      ).stdout.trim();
      assert.match(stagingContainer, /^[a-f0-9]{64}$/);
      await docker([
        'cp',
        `${publishedPackage.directory}/.`,
        `${stagingContainer}:/opt/published-package`,
      ]);
      await docker([
        'cp',
        config,
        `${stagingContainer}:/opt/published-package/operator-config.yaml`,
      ]);
      await assertOwned('container', stagingContainer);
      await docker(['rm', stagingContainer]);
      stagingContainer = undefined;
    }
    // Run the published daemon entrypoint, never a patched startup/guard. The npm
    // variant copies its complete frozen dependency tree onto public Node and
    // makes the runtime root filesystem read-only (no host-path mount assumptions);
    // it is not evidence about the separately published Agor Docker packaging.
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
        `${home}/.agor:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700`,
        ...(publishedPackage
          ? [
              '--user',
              '1000:1000',
              '--read-only',
              '--mount',
              `type=volume,src=${packageVolume},dst=/opt/published-package,readonly`,
            ]
          : []),
        '--entrypoint',
        publishedPackage ? 'node' : 'agor-daemon',
        '--env-file',
        envFile,
        image,
        ...(publishedPackage
          ? ['/opt/published-package/node_modules/agor-live/bin/agor-daemon.js']
          : []),
      ])
    ).stdout.trim();
    assert.match(container, /^[a-f0-9]{64}$/);
    if (publishedPackage) {
      assert.equal(
        (
          await docker([
            'container',
            'inspect',
            '--format',
            '{{.HostConfig.ReadonlyRootfs}}',
            container,
          ])
        ).stdout.trim(),
        'true'
      );
      const mounts = JSON.parse(
        (await docker(['container', 'inspect', '--format', '{{json .Mounts}}', container])).stdout
      );
      assert(
        mounts.some(
          (mount) =>
            mount.Name === packageVolume &&
            mount.Destination === '/opt/published-package' &&
            mount.RW === false
        )
      );
    } else await docker(['cp', config, `${container}:${home}/config.yaml`]);
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
      revision,
      entrypoint: publishedPackage ? 'agor-live/bin/agor-daemon.js' : 'agor-daemon',
      exit_code: 1,
      network: 'run-owned internal network; no published daemon ports or external egress',
      application: publishedPackage
        ? 'unmodified integrity-pinned published npm executable; frozen dependency tree on a read-only runtime filesystem; NOT the Agor Docker-image packaging'
        : 'unmodified published executable and dependencies; synthetic operator configuration only',
      ...(publishedPackage
        ? {
            package_version: publishedPackage.version,
            package_integrity: publishedPackage.integrity,
            dependency_lock_sha256: publishedPackage.dependency_lock_sha256,
          }
        : {}),
    };
  } finally {
    if (container) {
      await assertOwned('container', container);
      await docker(['rm', '--force', '--volumes', container]);
    }
    if (stagingContainer) {
      await assertOwned('container', stagingContainer);
      await docker(['rm', stagingContainer]);
    }
    if (packageVolume) {
      await assertOwned('volume', packageVolume);
      await docker(['volume', 'rm', packageVolume]);
    }
    if (network) {
      await assertOwned('network', network);
      if (connected) await docker(['network', 'disconnect', network, pg]);
      await docker(['network', 'rm', network]);
    }
  }
}
