/**
 * Node.js version check utility
 * Used by CLI and daemon entry points to ensure Node 22+ requirement
 */

import chalk from 'chalk';

export function checkNodeVersion() {
  const nodeVersion = process.versions.node;
  const [majorStr, minorStr] = nodeVersion.split('.');
  const major = parseInt(majorStr, 10);
  const minor = parseInt(minorStr, 10);

  if (major < 22 || (major === 22 && minor < 12)) {
    console.error(chalk.red('✖ Error: Agor requires Node.js v22.12.0 or higher'));
    console.error(chalk.yellow(`  Current version: v${nodeVersion}\n`));
    console.error('Please upgrade Node.js:');
    console.error(`  • Using nvm: ${chalk.cyan('nvm install 22 && nvm use 22')}`);
    console.error(`  • Download: ${chalk.cyan('https://nodejs.org/')}\n`);
    process.exit(1);
  }
}

// First releases with the fixed Brotli decoder (CVE-2026-111497); unlisted lines below 27 are end-of-life.
const BROTLI_FIXED_RELEASES = { 22: [23, 4], 24: [22, 1], 26: [12, 1] };

export function hasUnpatchedBrotliDecoder(nodeVersion) {
  const [major, minor, patch] = nodeVersion.split('.').map((part) => parseInt(part, 10));
  if (major >= 27) return false;
  const fixed = BROTLI_FIXED_RELEASES[major];
  if (!fixed) return true;
  return minor < fixed[0] || (minor === fixed[0] && patch < fixed[1]);
}

export function warnUnpatchedNode() {
  const nodeVersion = process.versions.node;
  if (!hasUnpatchedBrotliDecoder(nodeVersion)) return;
  console.warn(
    chalk.yellow(
      `⚠ Node.js v${nodeVersion} has a known remote code execution flaw in its Brotli decoder (CVE-2026-111497)`
    )
  );
  console.warn(
    `  Upgrade to v22.23.4, v24.22.1, v26.12.1 or newer: ${chalk.cyan('https://nodejs.org/')}\n`
  );
}
