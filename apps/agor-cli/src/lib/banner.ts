/**
 * CLI Banner & Hero Art
 */

import chalk from 'chalk';

/**
 * Agor ASCII hero art
 */
export const HERO_ART = `
   _____    ________ ________ __________
  /  _  \\  /  _____/ \\_____  \\\\______   \\
 /  /_\\  \\/   \\  ___  /   |   \\|       _/
/    |    \\    \\_\\  \\/    |    \\    |   \\
\\____|__  /\\______  /\\_______  /____|_  /
        \\/        \\/         \\/       \\/
`;

/**
 * Tagline
 */
export const TAGLINE = 'Team command center for all things agentic';

/**
 * Version info
 */
export const VERSION = '0.1.0';

/**
 * Full banner with hero art, tagline, and version
 */
export function getBanner(): string {
  return (
    chalk.cyan(HERO_ART) +
    '\n' +
    chalk.bold.white(`  ${TAGLINE}`) +
    '\n' +
    chalk.dim(`  v${VERSION}`) +
    '\n'
  );
}

/**
 * Compact banner (just name + version)
 */
export function getCompactBanner(): string {
  return chalk.cyan.bold('AGOR') + chalk.dim(` v${VERSION}`);
}
