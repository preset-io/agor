/** Published npm executable proof; distinct from the optional Docker-image proof. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

export const OLD_PACKAGE_VERSION = '0.26.3';
export const OLD_PACKAGE_SHA = '0fb3643582504f3bc38f0c7f57f1c98a29b319cb';
export const OLD_PACKAGE_INTEGRITY =
  'sha512-mm+ZMqBrfFW2EuIgIBPCBZ1ZL9MDHGfpOIrw1eqMgb1uf4UkmGeWiKF4ugjXPAdxz4hxuy5Q4+5R3LBOqjgjMg==';
// Official public Node linux/amd64 runtime, not an Agor image or a mutable tag.
export const PACKAGE_NODE_IMAGE =
  'docker.io/library/node@sha256:868499d55378719bffa87b0ed1f099591823c029b543043c09c2483468e93201';

export function validatePublishedPackageLock(lock) {
  assert.equal(lock.lockfileVersion, 3);
  const artifact = lock.packages['node_modules/agor-live'];
  assert.equal(artifact.version, OLD_PACKAGE_VERSION);
  assert.equal(artifact.integrity, OLD_PACKAGE_INTEGRITY);
  assert.equal(
    artifact.resolved,
    `https://registry.npmjs.org/agor-live/-/agor-live-${OLD_PACKAGE_VERSION}.tgz`
  );
  for (const [path, dependency] of Object.entries(lock.packages)) {
    if (path === '' || dependency.inBundle === true) continue;
    const url = new URL(dependency.resolved);
    assert.equal(url.origin, 'https://registry.npmjs.org');
    assert.equal(url.username + url.password + url.search + url.hash, '');
    assert.match(dependency.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  }
}

export async function preparePublishedOldPackage(directory, environment) {
  const install = join(directory, 'published-package');
  await mkdir(install);
  const fixtures = new URL('./fixtures/managed-old-package/', import.meta.url);
  const lockBytes = await readFile(new URL('package-lock.json', fixtures));
  validatePublishedPackageLock(JSON.parse(lockBytes.toString('utf8')));
  for (const name of ['package.json', 'package-lock.json'])
    await copyFile(new URL(name, fixtures), join(install, name));
  // Separate empty configs and an isolated HOME: no developer/npm credentials,
  // registry overrides, lifecycle scripts or inherited provider environment.
  const userConfig = join(directory, 'npm-user-empty');
  const globalConfig = join(directory, 'npm-global-empty');
  await writeFile(userConfig, '');
  await writeFile(globalConfig, '');
  try {
    await promisify(execFile)(
      'npm',
      [
        'ci',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--registry=https://registry.npmjs.org',
      ],
      {
        cwd: install,
        env: {
          ...environment,
          npm_config_userconfig: userConfig,
          npm_config_globalconfig: globalConfig,
        },
        timeout: 180000,
        maxBuffer: 1024 * 1024,
      }
    );
  } catch (error) {
    console.error(
      JSON.stringify({ stage: 'published-package-install', timed_out: error?.killed === true })
    );
    throw new Error('Pinned published package installation failed');
  }
  assert.deepEqual(await readFile(join(install, 'package-lock.json')), lockBytes);
  const root = join(install, 'node_modules/agor-live');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const build = JSON.parse(await readFile(join(root, 'dist/daemon/.build-info'), 'utf8'));
  assert.equal(manifest.version, OLD_PACKAGE_VERSION);
  assert.equal(build.sha, OLD_PACKAGE_SHA);
  assert.equal(manifest.bin['agor-daemon'], './bin/agor-daemon.js');
  return {
    directory: install,
    version: OLD_PACKAGE_VERSION,
    revision: OLD_PACKAGE_SHA,
    integrity: OLD_PACKAGE_INTEGRITY,
    dependency_lock_sha256: createHash('sha256').update(lockBytes).digest('hex'),
  };
}
