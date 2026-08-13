import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createPublishManifest, packRelease } from './pack-release.mjs';
import { BUNDLED_INTERNAL_PACKAGES } from './package-contract.js';

const execFileAsync = promisify(execFile);

test('publish manifest resolves the client workspace edge without install scripts', () => {
  const source = {
    name: 'agor-live',
    version: '1.2.3',
    dependencies: { '@agor-live/client': 'workspace:*' },
    scripts: { test: 'node --test' },
  };
  const published = createPublishManifest(source);
  assert.equal(published.dependencies['@agor-live/client'], '1.2.3');
  assert.equal(published.scripts, undefined);
  assert.equal(source.dependencies['@agor-live/client'], 'workspace:*');
});

test('publish manifest rejects installation lifecycle hooks', () => {
  assert.throws(
    () =>
      createPublishManifest({
        name: 'agor-live',
        version: '1.2.3',
        dependencies: { '@agor-live/client': 'workspace:*' },
        scripts: { postinstall: 'node scripts/postinstall.js' },
      }),
    /must not require npm lifecycle/
  );
});

test('release tarball materializes internal packages without postinstall', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'agor-live-pack-test-'));
  const output = join(fixture, 'output');
  const extract = join(fixture, 'extract');
  try {
    for (const directory of ['bin', 'dist']) {
      await mkdir(join(fixture, directory), { recursive: true });
      await writeFile(join(fixture, directory, 'fixture.js'), 'export {};\n');
    }
    await writeFile(join(fixture, 'LICENSE'), 'fixture\n');
    await writeFile(join(fixture, 'README.md'), '# fixture\n');
    const dependencies = { '@agor-live/client': 'workspace:*' };
    const bundleDependencies = [];
    for (const bundledPackage of BUNDLED_INTERNAL_PACKAGES) {
      const name = `@agor/${bundledPackage.name}`;
      dependencies[name] = '0.1.0';
      bundleDependencies.push(name);
      const directory = join(fixture, 'node_modules', '@agor', bundledPackage.distDirectory);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, 'package.json'),
        `${JSON.stringify({ name, version: '0.1.0', main: 'index.js' })}\n`
      );
      await writeFile(
        join(directory, 'index.js'),
        `export const name = ${JSON.stringify(name)};\n`
      );
    }
    await writeFile(
      join(fixture, 'package.json'),
      `${JSON.stringify({
        name: 'agor-live',
        version: '1.2.3',
        type: 'module',
        files: ['bin', 'dist', 'LICENSE', 'README.md'],
        dependencies,
        bundleDependencies,
      })}\n`
    );

    const tarball = await packRelease({ packageRoot: fixture, destination: output });
    await mkdir(extract);
    await execFileAsync('tar', ['-xzf', tarball, '-C', extract]);
    const manifest = JSON.parse(await readFile(join(extract, 'package', 'package.json'), 'utf8'));
    assert.equal(manifest.dependencies['@agor-live/client'], '1.2.3');
    assert.equal(manifest.scripts?.postinstall, undefined);
    for (const bundledPackage of BUNDLED_INTERNAL_PACKAGES) {
      const internalManifest = JSON.parse(
        await readFile(
          join(
            extract,
            'package',
            'node_modules',
            '@agor',
            bundledPackage.distDirectory,
            'package.json'
          ),
          'utf8'
        )
      );
      assert.equal(internalManifest.name, `@agor/${bundledPackage.name}`);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
