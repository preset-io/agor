// Regenerates the hosted OpenCode provider snapshot from the pinned binary. Run after every OpenCode bump.
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';

// Single-key SDKs in OpenCode's BUNDLED_PROVIDERS; anything else installs packages at turn time.
const CORE_SDKS = new Set([
  '@ai-sdk/alibaba',
  '@ai-sdk/anthropic',
  '@ai-sdk/cerebras',
  '@ai-sdk/cohere',
  '@ai-sdk/deepinfra',
  '@ai-sdk/gateway',
  '@ai-sdk/google',
  '@ai-sdk/groq',
  '@ai-sdk/mistral',
  '@ai-sdk/openai',
  '@ai-sdk/openai-compatible',
  '@ai-sdk/perplexity',
  '@ai-sdk/togetherai',
  '@ai-sdk/vercel',
  '@ai-sdk/xai',
  '@openrouter/ai-sdk-provider',
  'venice-ai-sdk-provider',
]);

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(root, '../..');
const output = resolve(root, '../agentic-tool-opencode/src/daemon/hosted-providers.generated.ts');
const require = createRequire(import.meta.url);
const packagePath = require.resolve('opencode-ai/package.json');
const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
const binary = resolve(
  dirname(packagePath),
  typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.opencode
);
const version = pkg.version;

const scratch = await mkdtemp(join(tmpdir(), 'agor-opencode-providers-'));
const dirs = Object.fromEntries(
  ['home', 'data', 'config', 'cache', 'state', 'work', 'managed'].map((name) => [
    name,
    join(scratch, name),
  ])
);
for (const path of Object.values(dirs)) await mkdir(path, { recursive: true });
const env = {
  PATH: process.env.PATH ?? '',
  HOME: dirs.home,
  XDG_DATA_HOME: dirs.data,
  XDG_CONFIG_HOME: dirs.config,
  XDG_CACHE_HOME: dirs.cache,
  XDG_STATE_HOME: dirs.state,
  OPENCODE_DB: join(dirs.data, 'opencode.db'),
  OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
  OPENCODE_PURE: 'true',
  OPENCODE_DISABLE_AUTOUPDATE: 'true',
  OPENCODE_DISABLE_MODELS_FETCH: 'true',
  OPENCODE_TEST_HOME: dirs.home,
  OPENCODE_TEST_MANAGED_CONFIG_DIR: dirs.managed,
  OPENCODE_SERVER_USERNAME: 'agor',
  OPENCODE_SERVER_PASSWORD: crypto.randomUUID(),
};
const child = spawn(binary, ['serve', '--hostname=127.0.0.1', '--port=0'], {
  cwd: dirs.work,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

try {
  const baseUrl = await new Promise((resolveUrl, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error(`OpenCode did not start: ${log}`)), 30_000);
    const onData = (chunk) => {
      log = `${log}${chunk}`.slice(-4000);
      const match = log.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolveUrl(match[1]);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`OpenCode exited (${code}): ${log}`)));
  });
  const auth = Buffer.from(`${env.OPENCODE_SERVER_USERNAME}:${env.OPENCODE_SERVER_PASSWORD}`);
  const client = createOpencodeClient({
    baseUrl,
    directory: dirs.work,
    headers: { Authorization: `Basic ${auth.toString('base64')}` },
  });
  const [list, methods] = await Promise.all([
    client.provider.list({ directory: dirs.work }),
    client.provider.auth({ directory: dirs.work }),
  ]);
  if (list.error || !list.data || methods.error) throw new Error('OpenCode catalog request failed');

  const lines = [];
  for (const provider of list.data.all) {
    const models = Object.values(provider.models);
    const providerMethods = methods.data?.[provider.id] ?? [];
    const keyOnly =
      // One credential; several names count only when all are aliases of one API key (Gemini).
      provider.env?.length &&
      (provider.env.length === 1 || provider.env.every((name) => name.endsWith('_API_KEY'))) &&
      !list.data.connected.includes(provider.id) &&
      providerMethods.every((method) => !method.prompts?.length) &&
      (providerMethods.length === 0 || providerMethods.some((method) => method.type === 'api'));
    const hostable = models.every((model) => {
      const url = model.api?.url ?? '';
      return CORE_SDKS.has(model.api?.npm) && !/localhost|127\.0\.0\.1/.test(url);
    });
    // Agents need tool calls and text in and out; image, audio, and embedding models can't run a turn.
    const usable = models
      .filter(
        (model) =>
          model.status === 'active' &&
          model.capabilities?.toolcall &&
          model.capabilities.input?.text &&
          model.capabilities.output?.text
      )
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    if (!keyOnly || !hostable || usable.length === 0) continue;
    const defaultModel = list.data.default[provider.id];
    lines.push(
      JSON.stringify({
        id: provider.id,
        name: provider.name,
        ...(usable.some((model) => model.id === defaultModel) ? { model: defaultModel } : {}),
        models: usable.map((model) =>
          model.name === model.id ? [model.id] : [model.id, model.name]
        ),
      })
    );
  }
  lines.sort();
  await writeFile(
    output,
    `// Generated by packages/agor-opencode/scripts/generate-hosted-providers.mjs from OpenCode ${version}; do not edit.\n` +
      `export const HOSTED_OPENCODE_SNAPSHOT_VERSION = ${JSON.stringify(version)};\n` +
      `/** One JSON-encoded provider per line: { id, name, model?, models: [id, name?][] } (active tool-calling text models). */\n` +
      `export const HOSTED_OPENCODE_PROVIDER_LINES: readonly string[] = [\n${lines
        .map((line) => `  ${JSON.stringify(line)},`)
        .join('\n')}\n];\n`
  );
  execFileSync('pnpm', ['exec', 'biome', 'format', '--write', output], { cwd: repoRoot });
  console.log(`Wrote ${lines.length} hosted OpenCode providers for ${version}.`);
} finally {
  if (child.exitCode === null && child.signalCode === null && child.pid) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  await rm(scratch, { recursive: true, force: true });
}
