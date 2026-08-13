#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { BUNDLED_INTERNAL_PACKAGES } from './package-contract.js';

const execFileAsync = promisify(execFile);
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISH_PATHS = ['bin', 'dist', 'LICENSE', 'README.md'];

function isContainedPath(root, candidate) {
  const path = relative(root, candidate);
  return !(path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path));
}

export function createPublishManifest(source) {
  const manifest = structuredClone(source);
  const clientVersion = manifest.dependencies?.['@agor-live/client'];
  if (typeof clientVersion !== 'string') {
    throw new Error('@agor-live/client must be a release dependency');
  }
  if (clientVersion.startsWith('workspace:')) {
    manifest.dependencies['@agor-live/client'] = manifest.version;
  } else if (clientVersion !== manifest.version) {
    throw new Error(
      `@agor-live/client ${clientVersion} does not match agor-live ${manifest.version}`
    );
  }
  if (manifest.scripts?.preinstall || manifest.scripts?.install || manifest.scripts?.postinstall) {
    throw new Error(
      'agor-live release packages must not require npm lifecycle installation scripts'
    );
  }
  // Build/check commands are repository tooling, not installed runtime APIs.
  delete manifest.scripts;
  return manifest;
}

async function assertMaterializedInternalPackage(internalRoot, bundledPackage) {
  const expectedName = `@agor/${bundledPackage.name}`;
  const directory = join(internalRoot, bundledPackage.distDirectory);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${expectedName} must be a materialized directory; run build.sh first`);
  }
  const canonicalRoot = await realpath(internalRoot);
  const canonicalDirectory = await realpath(directory);
  if (!isContainedPath(canonicalRoot, canonicalDirectory)) {
    throw new Error(`${expectedName} resolves outside the agor-live package`);
  }
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (manifest.name !== expectedName) {
    throw new Error(
      `${directory} contains ${manifest.name ?? 'an unnamed package'}, expected ${expectedName}`
    );
  }
  return directory;
}

export async function packRelease({ packageRoot = scriptRoot, destination, internalPackageRoot }) {
  const root = resolve(packageRoot);
  const internalRoot = resolve(internalPackageRoot ?? join(root, 'node_modules', '@agor'));
  const outputDirectory = resolve(destination ?? root);
  const sourceManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = createPublishManifest(sourceManifest);
  const bundledNames = new Set(manifest.bundleDependencies ?? manifest.bundledDependencies ?? []);
  const expectedNames = new Set(
    BUNDLED_INTERNAL_PACKAGES.map((bundledPackage) => `@agor/${bundledPackage.name}`)
  );
  if (
    bundledNames.size !== expectedNames.size ||
    [...expectedNames].some((name) => !bundledNames.has(name))
  ) {
    throw new Error('bundleDependencies must exactly match the internal package contract');
  }

  const internalPackages = [];
  for (const bundledPackage of BUNDLED_INTERNAL_PACKAGES) {
    const source = await assertMaterializedInternalPackage(internalRoot, bundledPackage);
    const internalManifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    const packageName = `@agor/${bundledPackage.name}`;
    const sourceRange = sourceManifest.dependencies?.[packageName];
    if (
      !internalManifest.version ||
      (sourceRange !== 'workspace:*' && sourceRange !== internalManifest.version)
    ) {
      throw new Error(
        `${packageName} must be workspace:* in source or match bundled version ${internalManifest.version ?? '(missing)'}`
      );
    }
    manifest.dependencies[packageName] = internalManifest.version;
    internalPackages.push({ bundledPackage, source });
  }

  const stageParent = await mkdtemp(join(tmpdir(), 'agor-live-pack-'));
  const stage = join(stageParent, 'package');
  try {
    await mkdir(stage, { recursive: true });
    for (const publishPath of PUBLISH_PATHS) {
      await cp(join(root, publishPath), join(stage, publishPath), { recursive: true });
    }
    await writeFile(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    for (const { bundledPackage, source } of internalPackages) {
      const target = join(stage, 'node_modules', '@agor', bundledPackage.distDirectory);
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target, { recursive: true });
    }

    await mkdir(outputDirectory, { recursive: true });
    const { stdout } = await execFileAsync(
      'npm',
      ['pack', '--json', '--ignore-scripts', '--pack-destination', outputDirectory],
      { cwd: stage, maxBuffer: 10 * 1024 * 1024 }
    );
    const [packed] = JSON.parse(stdout);
    if (!packed?.filename) throw new Error(`npm pack returned no filename: ${stdout}`);
    return join(outputDirectory, basename(packed.filename));
  } finally {
    await rm(stageParent, { recursive: true, force: true });
  }
}

const invoked = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;
if (invoked) {
  const destinationIndex = process.argv.indexOf('--destination');
  const destination = destinationIndex === -1 ? undefined : process.argv[destinationIndex + 1];
  if (destinationIndex !== -1 && !destination) {
    throw new Error('--destination requires a directory');
  }
  const internalRootIndex = process.argv.indexOf('--internal-root');
  const internalPackageRoot =
    internalRootIndex === -1 ? undefined : process.argv[internalRootIndex + 1];
  if (internalRootIndex !== -1 && !internalPackageRoot) {
    throw new Error('--internal-root requires a directory');
  }
  console.log(await packRelease({ destination, internalPackageRoot }));
}
