import {
  WORKLOAD_OFFLINE_INSTALL_ARTIFACT_SHA256,
  WORKLOAD_OFFLINE_INSTALL_ID,
  WORKLOAD_OFFLINE_INSTALL_LOCKFILE_SHA256,
  WORKLOAD_OFFLINE_INSTALL_PACKAGE_MANAGER,
  WORKLOAD_OFFLINE_INSTALL_PACKAGE_MANAGER_VERSION,
  WORKLOAD_OFFLINE_INSTALL_PACKAGE_NAME,
  WORKLOAD_OFFLINE_INSTALL_PACKAGE_VERSION,
} from '@agor/core/types';

const PACKAGE_JSON = `${JSON.stringify({
  name: 'agor-node-offline-install-v1',
  version: '1.0.0',
  private: true,
  type: 'module',
  packageManager: `${WORKLOAD_OFFLINE_INSTALL_PACKAGE_MANAGER}@${WORKLOAD_OFFLINE_INSTALL_PACKAGE_MANAGER_VERSION}`,
  dependencies: {
    [WORKLOAD_OFFLINE_INSTALL_PACKAGE_NAME]:
      'file:vendor/agor-offline-fixture-dependency-1.0.0.tgz',
  },
})}\n`;

const PNPM_LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      '@agor/offline-fixture-dependency':
        specifier: file:vendor/agor-offline-fixture-dependency-1.0.0.tgz
        version: file:vendor/agor-offline-fixture-dependency-1.0.0.tgz

packages:

  '@agor/offline-fixture-dependency@file:vendor/agor-offline-fixture-dependency-1.0.0.tgz':
    resolution: {integrity: sha512-5tfa6TtChl2IwpdPNwc4xhatLci4ZquHwuS2SbMgZMzjXmfSwlRycOATxxEnigrP47r5cSBY9C2o8nvh+8hx+A==, tarball: file:vendor/agor-offline-fixture-dependency-1.0.0.tgz}
    version: 1.0.0

snapshots:

  '@agor/offline-fixture-dependency@file:vendor/agor-offline-fixture-dependency-1.0.0.tgz': {}
`;

const VERIFY_TEST = `import assert from 'node:assert/strict';
import test from 'node:test';
import { fixedTotal } from '@agor/offline-fixture-dependency';

test('uses the installed offline dependency', () => {
  assert.equal(fixedTotal([3, 5, 8, 13, 21, 34]), 84);
});
`;

const ARTIFACT_BASE64 =
  'H4sIAAAAAAAC/+2UzUrEMBRGu+5TXLpqsZOmTFtBUXwId+IitLdDxzYp+Rk6DL67t1achYKbcRwhZ3OTk4QkhC+jqF/EBrNxqWxrlAxODOe8Kgr4zs/k1zS2Liue51XFqU2NsuRUgzPgjBWajnKCSxLwWf8Jh0iKAaOb6EFslM5U2/adxFXbTdZpXDU4omxQ1vsojXaoTackTc4ZZ5yM3Y/z2kE1rkfq4zQqbQ0plnW0bmLD1pBvux7JPkVH+fwaBp4/5yP3x9f6hT1+yn+x/pL/nPv8n4UlsdA6WVvKNlDwsXlUVvTxTvQOTQKHEEAjfQcSFsU0Nq7GOLbzvHSxCdzdw7uAq8WkwJPb0Mfc4/F4LpI3F+nn2AAMAAA=';

export type OfflineInstallFixtureFile = Readonly<{
  name: string;
  encoding: 'utf8' | 'base64';
  content: string;
}>;

function immutableFile(
  name: string,
  content: string,
  encoding: OfflineInstallFixtureFile['encoding'] = 'utf8'
): OfflineInstallFixtureFile {
  return Object.freeze({ name, encoding, content });
}

export function offlineInstallFixtureBytes(file: OfflineInstallFixtureFile): Buffer {
  return Buffer.from(file.content, file.encoding);
}

export const OFFLINE_INSTALL_FIXTURE = Object.freeze({
  id: WORKLOAD_OFFLINE_INSTALL_ID,
  packageManager: Object.freeze({
    name: WORKLOAD_OFFLINE_INSTALL_PACKAGE_MANAGER,
    version: WORKLOAD_OFFLINE_INSTALL_PACKAGE_MANAGER_VERSION,
  }),
  dependency: Object.freeze({
    name: WORKLOAD_OFFLINE_INSTALL_PACKAGE_NAME,
    version: WORKLOAD_OFFLINE_INSTALL_PACKAGE_VERSION,
    artifactSha256: WORKLOAD_OFFLINE_INSTALL_ARTIFACT_SHA256,
  }),
  lockfileSha256: WORKLOAD_OFFLINE_INSTALL_LOCKFILE_SHA256,
  files: Object.freeze([
    immutableFile('package.json', PACKAGE_JSON),
    immutableFile('pnpm-lock.yaml', PNPM_LOCK),
    immutableFile('verify.test.mjs', VERIFY_TEST),
    immutableFile('vendor/agor-offline-fixture-dependency-1.0.0.tgz', ARTIFACT_BASE64, 'base64'),
  ]),
});

export const OFFLINE_INSTALL_COMMANDS = Object.freeze({
  packageManagerVersion: Object.freeze({
    step: 'package-manager-version' as const,
    executable: WORKLOAD_OFFLINE_INSTALL_PACKAGE_MANAGER,
    argv: ['--version'] as const,
  }),
  install: Object.freeze({
    step: 'install' as const,
    executable: WORKLOAD_OFFLINE_INSTALL_PACKAGE_MANAGER,
    argv: [
      'install',
      '--offline',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--reporter=silent',
      '--store-dir=../store',
      '--virtual-store-dir=.pnpm',
      '--package-import-method=copy',
      '--config.manage-package-manager-versions=false',
    ] as const,
  }),
  compile: Object.freeze({
    step: 'compile' as const,
    executable: process.execPath,
    argv: ['--check', 'node_modules/@agor/offline-fixture-dependency/index.mjs'] as const,
  }),
  test: Object.freeze({
    step: 'test' as const,
    executable: process.execPath,
    argv: ['--test', '--test-reporter=dot', 'verify.test.mjs'] as const,
  }),
});

export type OfflineInstallCommand =
  (typeof OFFLINE_INSTALL_COMMANDS)[keyof typeof OFFLINE_INSTALL_COMMANDS];
