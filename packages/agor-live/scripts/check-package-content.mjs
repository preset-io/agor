import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const limits = {
  files: 2600,
  unpackedBytes: 98 * 1024 * 1024,
  packedBytes: 24 * 1024 * 1024,
};

function measureDirectory(directory) {
  let files = 0;
  let unpackedBytes = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = measureDirectory(path);
      files += nested.files;
      unpackedBytes += nested.unpackedBytes;
    } else {
      files += 1;
      unpackedBytes += statSync(path).size;
    }
  }
  return { files, unpackedBytes };
}

const scriptRoot = resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(join(scriptRoot, 'package.json'), 'utf8')).version;
const tarball = process.argv[2]
  ? resolve(process.argv[2])
  : join(scriptRoot, 'release', `agor-live-${version}.tgz`);
try {
  const extractRoot = mkdtempSync(join(tmpdir(), 'agor-live-content-extract-'));
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', extractRoot]);
    const measurements = {
      ...measureDirectory(join(extractRoot, 'package')),
      packedBytes: statSync(tarball).size,
    };
    const failures = Object.entries(limits)
      .filter(([key, limit]) => measurements[key] > limit)
      .map(([key, limit]) => `${key}: ${measurements[key]} > ${limit}`);

    console.log(
      `Package content: ${measurements.files} files, ` +
        `${(measurements.packedBytes / 1024 / 1024).toFixed(2)} MiB packed, ` +
        `${(measurements.unpackedBytes / 1024 / 1024).toFixed(2)} MiB unpacked`
    );
    if (failures.length) {
      throw new Error(`agor-live package-content budget exceeded:\n- ${failures.join('\n- ')}`);
    }
  } finally {
    rmSync(extractRoot, { recursive: true, force: true });
  }
} catch (error) {
  if (error?.code === 'ENOENT') {
    throw new Error(`Release tarball not found: ${tarball}. Run build.sh first.`, { cause: error });
  }
  throw error;
}
