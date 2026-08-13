import { readdir, readFile } from 'node:fs/promises';
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
const EXACT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
for (const dependency of forbiddenBaseDependencies) {
  if (base.dependencies?.[dependency]) failures.push(`agor-live must not depend on ${dependency}`);
}

// Published/runtime packages must not acquire an agent SDK except through its
// exact-version integration wrapper. Source packages may retain them solely as
// devDependencies for TypeScript and tests; those are absent from agor-live.
const runtimeManifestAllowlist = new Set(
  integrations.map((id) => `packages/agor-${id}/package.json`)
);
for (const parent of ['packages', 'apps']) {
  for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const relative = `${parent}/${entry.name}/package.json`;
    let pkg;
    try {
      pkg = JSON.parse(await readFile(join(root, relative), 'utf8'));
    } catch {
      continue;
    }
    for (const dependency of forbiddenBaseDependencies) {
      if (pkg.dependencies?.[dependency] && !runtimeManifestAllowlist.has(relative)) {
        failures.push(
          `${relative}: ${dependency} must be dev-only or owned by an integration wrapper`
        );
      }
      if (pkg.optionalDependencies?.[dependency]) {
        failures.push(
          `${relative}: ${dependency} must not bypass agor install via optionalDependencies`
        );
      }
    }
  }
}

const coreSdk = await readFile(join(root, 'packages/core/src/sdk/index.ts'), 'utf8');
if (
  /export\s+\*\s+as\s+\w+\s+from\s+['"](?:@anthropic-ai\/claude-agent-sdk|@openai\/codex-sdk)['"]/.test(
    coreSdk
  )
) {
  failures.push(
    'packages/core/src/sdk/index.ts must remain type-only; runtime SDKs use the managed loader'
  );
}
for (const id of integrations) {
  const directory = join(root, `packages/agor-${id}`);
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (pkg.name !== `@agor-live/${id}`) failures.push(`${id}: unexpected package name ${pkg.name}`);
  if (pkg.version !== base.version)
    failures.push(`${pkg.name}: ${pkg.version} != agor-live ${base.version}`);
  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
    if (!EXACT_SEMVER.test(range))
      failures.push(`${pkg.name}: ${name} must use an exact version, found ${range}`);
  }
  const source = await readFile(join(directory, 'src/index.ts'), 'utf8');
  if (!source.includes(`AGOR_INTEGRATION_VERSION = '${base.version}'`)) {
    failures.push(`${pkg.name}: source integration version does not match ${base.version}`);
  }
}

const opencodeWrapper = JSON.parse(
  await readFile(join(root, 'packages/agor-opencode/package.json'), 'utf8')
);
const opencodeRuntimeVersion = opencodeWrapper.dependencies?.['opencode-ai'];
const opencodeToolManifest = JSON.parse(
  await readFile(join(root, 'packages/agentic-tool-opencode/package.json'), 'utf8')
);
const opencodeKnownModels = await readFile(
  join(root, 'packages/agentic-tool-opencode/src/shared/known-models.ts'),
  'utf8'
);
const opencodeIntegration = await readFile(
  join(root, 'packages/agentic-tool-opencode/src/shared/index.ts'),
  'utf8'
);
const opencodeVersionOwners = {
  'wrapper opencode-ai': opencodeRuntimeVersion,
  'wrapper @opencode-ai/sdk': opencodeWrapper.dependencies?.['@opencode-ai/sdk'],
  'tool devDependency @opencode-ai/sdk': opencodeToolManifest.devDependencies?.['@opencode-ai/sdk'],
  OPENCODE_VERSION: opencodeKnownModels.match(/OPENCODE_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1],
  'OPENCODE_INTEGRATION.sdkVersion': opencodeIntegration.match(
    /sdkVersion:\s*['"]@opencode-ai\/sdk@([^'"]+)['"]/
  )?.[1],
};
for (const [owner, version] of Object.entries(opencodeVersionOwners)) {
  if (version !== opencodeRuntimeVersion || !EXACT_SEMVER.test(version ?? '')) {
    failures.push(
      `OpenCode version drift: ${owner} is ${version ?? 'missing'}, expected ${opencodeRuntimeVersion}`
    );
  }
}
for (const [path, expected] of [
  ['docker/Dockerfile', `npm install -g opencode-ai@${opencodeRuntimeVersion}`],
]) {
  const contents = await readFile(join(root, path), 'utf8');
  if (!contents.includes(expected)) {
    failures.push(`${path}: OpenCode runtime must match ${opencodeRuntimeVersion}`);
  }
}
// Everything publishable must sit in a namespace we own on npm.
//
// The six integration wrappers shipped briefly as `@agor/<tool>`. `@agor` is the
// *private* workspace scope (@agor/core, @agor/git, @agor/agentic-tools, ...) and
// is not a namespace this project owns on the registry, so `build.sh --publish`
// died on the very first package with "404 Scope not found". Publishable packages
// are `agor-live` or `@agor-live/*`; anything `@agor/*` is internal and must say
// so with `private: true`.
const PUBLISHABLE_NAME = /^(agor-live|@agor-live\/[a-z0-9-]+)$/;
for (const parent of ['packages', 'apps']) {
  let entries;
  try {
    entries = await readdir(join(root, parent), { withFileTypes: true });
  } catch {
    continue;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let pkg;
    try {
      pkg = JSON.parse(await readFile(join(root, parent, entry.name, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    if (pkg.private === true) continue;
    if (!PUBLISHABLE_NAME.test(pkg.name ?? '')) {
      failures.push(
        `${parent}/${entry.name}: "${pkg.name}" is publishable but not under a namespace we own ` +
          `(expected agor-live or @agor-live/*) — add "private": true if it is internal`
      );
    }
  }
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}
console.log(`Agentic tool packages are aligned at ${base.version}.`);
