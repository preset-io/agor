import { buildGitConfigParameters } from './index.js';

/** Append process-scoped Git configuration without mutating user gitconfig. */
export function appendGitConfigParameterPairs(pairs: readonly string[]): void {
  const encoded = buildGitConfigParameters(pairs);
  if (!encoded) return;

  const existing = process.env.GIT_CONFIG_PARAMETERS?.trim();
  process.env.GIT_CONFIG_PARAMETERS = existing ? `${existing} ${encoded}` : encoded;
}
