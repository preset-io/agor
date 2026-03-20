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
