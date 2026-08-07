import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const base = JSON.parse(await readFile(join(root, 'packages/agor-live/package.json'), 'utf8'));
const integrations = ['claude', 'codex', 'copilot', 'gemini', 'opencode', 'cursor'];
const forbiddenBaseDependencies = [
  '@anthropic-ai/claude-agent-sdk',
  '@openai/codex-sdk',
  '@github/copilot-sdk',
  '@google/gemini-cli-core',
  '@cursor/sdk',
  '@opencode-ai/sdk',
  'opencode-ai',
];
const failures = [];
for (const dependency of forbiddenBaseDependencies) {
  if (base.dependencies?.[dependency]) failures.push(`agor-live must not depend on ${dependency}`);
}
for (const id of integrations) {
  const directory = join(root, `packages/agor-${id}`);
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (pkg.name !== `@agor/${id}`) failures.push(`${id}: unexpected package name ${pkg.name}`);
  if (pkg.version !== base.version)
    failures.push(`${pkg.name}: ${pkg.version} != agor-live ${base.version}`);
  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
    if (/^[~^*]|\s|\|/.test(range))
      failures.push(`${pkg.name}: ${name} must use an exact version, found ${range}`);
  }
  const source = await readFile(join(directory, 'src/index.ts'), 'utf8');
  if (!source.includes(`AGOR_INTEGRATION_VERSION = '${base.version}'`)) {
    failures.push(`${pkg.name}: source integration version does not match ${base.version}`);
  }
}
if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}
console.log(`Agentic tool packages are aligned at ${base.version}.`);
