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
 * Full banner with hero art and tagline. Oclif renders the package version.
 */
export function getBanner(): string {
  return `${chalk.cyan(HERO_ART)}\n${chalk.bold.white(`  ${TAGLINE}`)}\n`;
}

/**
 * Compact banner (just name + version)
 */
export function getCompactBanner(): string {
  return chalk.cyan.bold('AGOR');
}
