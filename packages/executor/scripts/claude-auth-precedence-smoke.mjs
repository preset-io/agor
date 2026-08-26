/**
 * Empirical contract test for the exact Claude runtime pinned by this package.
 *
 * This intentionally executes the bundled native CLI against a loopback
 * Messages API. It proves that CLAUDE_CODE_OAUTH_TOKEN wins over canonical
 * native credentials, that the CLI does not mutate those credentials on a
 * successful request, and that the same env path works when the canonical file
 * is absent or masked by /dev/null.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux') {
  console.log('Claude containment precedence smoke requires Linux; skipping on this platform.');
  process.exit(0);
}

const ENV_TOKEN = 'sk-ant-oat01-agor-runtime-env-winner';
const FILE_TOKEN = 'sk-ant-oat01-deliberately-wrong-file-token';
const REFRESH_TOKEN = 'sk-ant-ort01-deliberately-wrong-file-token';

function pnpmStoreFromSdkEntry(entry) {
  let current = dirname(fileURLToPath(entry));
  while (basename(current) !== '.pnpm' && dirname(current) !== current) current = dirname(current);
  assert.equal(basename(current), '.pnpm', 'Claude SDK is not installed from the pnpm store');
  return current;
}

async function pinnedClaudeBinary() {
  assert.equal(process.platform, 'linux', 'This containment smoke test requires the Linux CLI');
  const sdkEntry = import.meta.resolve('@anthropic-ai/claude-agent-sdk');
  const sdkRoot = dirname(fileURLToPath(sdkEntry));
  const sdkPackage = JSON.parse(await readFile(join(sdkRoot, 'package.json'), 'utf8'));
  const architecture = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : null;
  assert.ok(architecture, `Unsupported Linux architecture: ${process.arch}`);
  const prefix = `@anthropic-ai+claude-agent-sdk-linux-${architecture}@${sdkPackage.version}`;
  const packageDirectory = (await readdir(pnpmStoreFromSdkEntry(sdkEntry))).find((name) =>
    name.startsWith(prefix)
  );
  assert.ok(packageDirectory, `Pinned Claude runtime package ${prefix} is not installed`);
  return join(
    pnpmStoreFromSdkEntry(sdkEntry),
    packageDirectory,
    'node_modules',
    `@anthropic-ai/claude-agent-sdk-linux-${architecture}`,
    'claude'
  );
}

function successfulMessageStream() {
  const events = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_agor_smoke',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-sonnet-5',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    ],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  return `${events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`).join('\n')}\n`;
}

async function runCase(binary, mode) {
  const root = await mkdtemp(join(tmpdir(), `agor-claude-auth-${mode}-`));
  const configDir = join(root, '.claude');
  const credentialPath = join(configDir, '.credentials.json');
  await mkdir(configDir, { mode: 0o700 });

  let originalBytes;
  let originalMtimeNs;
  if (mode === 'wrong-file' || mode === 'nodev-mask') {
    originalBytes = `${JSON.stringify({ claudeAiOauth: { accessToken: FILE_TOKEN, refreshToken: REFRESH_TOKEN, expiresAt: Date.now() + 86_400_000, scopes: ['user:inference'] } }, null, 2)}\n`;
    await writeFile(credentialPath, originalBytes, { mode: 0o600 });
    await utimes(credentialPath, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    originalMtimeNs = (await stat(credentialPath, { bigint: true })).mtimeNs;
  } else if (mode === 'masked') {
    await symlink('/dev/null', credentialPath);
  }

  const authorizations = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain request bodies so the CLI can reuse/close the connection cleanly.
    }
    if (request.url?.startsWith('/v1/messages')) {
      authorizations.push(request.headers.authorization);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(successfulMessageStream());
      return;
    }
    // The CLI may probe the base URL before inference.
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const claudeArgs = [
      '--print',
      'reply ok',
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      '1',
      '--dangerously-skip-permissions',
    ];
    const command = mode === 'nodev-mask' ? 'bwrap' : binary;
    const commandArgs =
      mode === 'nodev-mask'
        ? [
            '--unshare-user',
            '--ro-bind',
            '/',
            '/',
            '--dev',
            '/dev',
            '--bind',
            configDir,
            configDir,
            '--ro-bind',
            '/dev/null',
            credentialPath,
            '--',
            binary,
            ...claudeArgs,
          ]
        : claudeArgs;
    const child = spawn(command, commandArgs, {
      cwd: root,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: root,
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_CODE_OAUTH_TOKEN: ENV_TOKEN,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timeout);
    assert.deepEqual(exit, { code: 0, signal: null }, `Claude CLI failed: ${stderr}`);
    assert.deepEqual(authorizations, [`Bearer ${ENV_TOKEN}`]);

    if (mode === 'wrong-file' || mode === 'nodev-mask') {
      assert.equal(await readFile(credentialPath, 'utf8'), originalBytes);
      assert.equal((await stat(credentialPath, { bigint: true })).mtimeNs, originalMtimeNs);
    } else if (mode === 'masked') {
      assert.equal((await lstat(credentialPath)).isSymbolicLink(), true);
      assert.equal(await readFile(credentialPath, 'utf8'), '');
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

if (process.platform !== 'linux') {
  // The reviewed containment contract is implemented by the pinned Linux CLI
  // plus bubblewrap. macOS/Windows developers still run the portable unit
  // suite, but must not fail merely because pnpm did not install a Linux-only
  // optional package for this empirical smoke arm.
  console.log('Skipping Claude containment smoke: the pinned runtime contract is Linux-only.');
} else {
  const binary = await pinnedClaudeBinary();
  for (const mode of ['wrong-file', 'masked', 'absent']) await runCase(binary, mode);
  const bwrapAvailable =
    spawnSync('bwrap', ['--unshare-user', '--ro-bind', '/', '/', '--', '/bin/true'], {
      stdio: 'ignore',
    }).status === 0;
  if (bwrapAvailable) {
    await runCase(binary, 'nodev-mask');
    console.log('Claude env-auth precedence passed with the canonical file masked on nodev.');
  } else {
    console.log('bubblewrap unavailable; skipping the live nodev mask arm.');
  }
  console.log(
    'Claude env-auth precedence passed: wrong canonical file unchanged; masked/absent paths work.'
  );
}
