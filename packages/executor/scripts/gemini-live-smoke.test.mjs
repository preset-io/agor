import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  agentEnvironment,
  assertEnvironment,
  assertRecall,
  assertSubagent,
  assertTask,
  successfulToolResults,
  visibleEnvMarker,
} from './gemini-live-smoke.mjs';

const transcript = (name, content, is_error = false) => [
  {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'call-1', name, input: { command: 'env' } },
      { type: 'tool_result', tool_use_id: 'call-1', content, is_error },
    ],
  },
];

test('no key reports not validated without loading a package or making inference', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'gemini-no-key-'));
  try {
    const summary = join(root, 'summary');
    const output = join(root, 'output');
    const env = { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output };
    const result = spawnSync(
      process.execPath,
      [new URL('./gemini-live-smoke.mjs', import.meta.url).pathname, '/does-not-exist'],
      { env, encoding: 'utf8' }
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout, /not validated \(no GEMINI_API_KEY\)/);
    assert.equal(result.stderr, '');
    assert.match(await fs.readFile(summary, 'utf8'), /not validated/);
    assert.equal(await fs.readFile(output, 'utf8'), 'validation=not validated\n');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('agent environment removes CI markers and credentials, not ordinary env proof', () => {
  const env = agentEnvironment('/home/fixture', '/tools', '1.0.0', 'http://127.0.0.1:1');
  for (const name of ['GITHUB_SHA', 'SURFACE', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'NODE_OPTIONS'])
    assert.equal(env[name], undefined);
  assert.equal(env.GITHUB_TOKEN, visibleEnvMarker);
  assert.equal(env.GEMINI_CLI_HOME, '/home/fixture');
});

test('only matched stored successful tool results count, not prose or errors', () => {
  assert.equal(successfulToolResults(transcript('Read', 'file contents'), 'Read').length, 1);
  assert.equal(successfulToolResults(transcript('Read', 'denied', true), 'Read').length, 0);
  assert.equal(
    successfulToolResults(
      [{ role: 'assistant', content: [{ type: 'text', text: 'I read the file' }] }],
      'Read'
    ).length,
    0
  );
  const orphan = transcript('Read', 'contents');
  orphan[0].content[1].tool_use_id = 'unrelated';
  assert.equal(successfulToolResults(orphan, 'Read').length, 0);
});

test('terminal states and nonce exception cannot pass from user prompt or model claims', () => {
  assertTask({ status: 'stopped', completed_at: 'now' }, 'stopped');
  assert.throws(() => assertTask({ status: 'running' }));
  assert.throws(() => assertTask({ status: 'failed', completed_at: 'now' }));
  assertRecall([{ role: 'assistant', content: [{ type: 'text', text: 'nonce' }] }], 'nonce');
  assert.throws(() =>
    assertRecall([{ role: 'user', content: [{ type: 'text', text: 'nonce' }] }], 'nonce')
  );
});

test('env requires successful execution, retained ordinary variable and no key/CI stripping', () => {
  const safe = `PATH=/bin\nGITHUB_TOKEN=${visibleEnvMarker}\n`;
  assertEnvironment(transcript('Bash', safe), 'private-fixture-key');
  for (const unsafe of [
    `${safe}private-fixture-key`,
    `${safe}GITHUB_SHA=abc`,
    `${safe}SURFACE=Github`,
    `${safe}GEMINI_API_KEY=other`,
    'PATH=/bin',
  ])
    assert.throws(() => assertEnvironment(transcript('Bash', unsafe), 'private-fixture-key'));
  assert.throws(() => assertEnvironment(transcript('Bash', safe, true), 'private-fixture-key'));
});

test('packaged missing-key task stores failure without inference', {
  skip: !process.env.GEMINI_SMOKE_TEST_PACKAGE,
}, async () => {
  const { runSmoke } = await import('./gemini-live-smoke.mjs');
  const result = await runSmoke({
    packageRoot: process.env.GEMINI_SMOKE_TEST_PACKAGE,
    tools: process.env.GEMINI_SMOKE_TEST_TOOLS,
    missingKeyProbe: true,
  });
  assert.deepEqual(result, { status: 'not validated', stage: 'offline missing-key adapter' });
});

test('live workflow cannot receive PR secrets and no-key branch uses the real reporter', async () => {
  const workflow = await fs.readFile(
    new URL('../../../.github/workflows/gemini-live-smoke.yml', import.meta.url),
    'utf8'
  );
  assert.match(workflow, /schedule:\n\s+- cron:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request(?:_target)?:|workflow_call:|secrets: inherit/);
  assert.match(workflow, /github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment: gemini-live-smoke/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(
    workflow,
    /if \[ -z "\$GEMINI_API_KEY" \]; then\n\s+node packages\/executor\/scripts\/gemini-live-smoke.mjs/
  );
  assert.doesNotMatch(workflow, /upload-artifact/);
});

test('sub-agent SDK completion envelope rejects failure/turn-limit despite successful outer tool', () => {
  const result = (reason) => {
    const messages = transcript(
      'invoke_agent',
      JSON.stringify([
        {
          functionResponse: {
            response: {
              output: `Subagent 'smoke_worker' finished.\nTermination Reason: ${reason}\nResult:\nmodel text`,
            },
          },
        },
      ])
    );
    messages[0].content[0].input = { agent_name: 'smoke_worker' };
    return messages;
  };
  assertSubagent(result('GOAL'));
  for (const reason of ['ERROR', 'MAX_TURNS', 'TIMEOUT', 'ERROR_NO_COMPLETE_TASK_CALL'])
    assert.throws(() => assertSubagent(result(reason)));
  assert.throws(() => assertSubagent(transcript('smoke_worker', 'I completed')));
});

for (const offlineProbe of ['success', 'failure']) {
  test(`packaged fake-key ${offlineProbe} persists task usage without provider requests`, {
    skip: !process.env.GEMINI_SMOKE_TEST_PACKAGE,
  }, async () => {
    const { runSmoke } = await import('./gemini-live-smoke.mjs');
    const result = await runSmoke({
      packageRoot: process.env.GEMINI_SMOKE_TEST_PACKAGE,
      tools: process.env.GEMINI_SMOKE_TEST_TOOLS,
      apiKey: 'offline-not-a-real-key',
      offlineProbe,
    });
    assert.deepEqual(result, { status: 'not validated', stage: 'offline packaged adapter' });
  });
}
