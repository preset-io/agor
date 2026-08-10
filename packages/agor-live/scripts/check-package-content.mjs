import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const limits = {
  files: 2400,
  // A modest byte increase buys a much larger inode/package reduction: select
  // high-fanout pure-JS trees are bundled into dist instead of extracted as
  // hundreds of dependency files during a cold global npm install.
  unpackedBytes: 95 * 1024 * 1024,
  packedBytes: 23 * 1024 * 1024,
};

let filename;
try {
  const output = execFileSync('npm', ['pack', '--json', '--ignore-scripts'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  const [pack] = JSON.parse(output);
  filename = pack.filename;
  const measurements = {
    files: pack.entryCount ?? pack.files.length,
    unpackedBytes: pack.unpackedSize,
    packedBytes: pack.size,
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
  if (filename) rmSync(new URL(`../${filename}`, import.meta.url), { force: true });
}
