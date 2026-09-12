// A deterministic executor fixture. This is explicitly not an LLM validation.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const payload = JSON.parse(Buffer.concat(chunks).toString());
const input = JSON.parse(payload.params.prompt);
assert.deepEqual(
  await readdir('/workspace'),
  [],
  'SDK must start independently of the source replica'
);
console.log('PROOF_SDK_READY_BEFORE_FILES');
const transcript = `/home/agor/.claude/projects/-workspace/${payload.params.sessionId}.jsonl`;
if (input.checkTranscript) assert.equal(await readFile(transcript, 'utf8'), 'fixture transcript\n');
const request = { command: input.command, timeout_ms: 120000, idempotencyKey: randomUUID() };
const invoke = async () => {
  const r = await fetch(`${payload.replicatedWorkspace.endpoint}/execute`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${payload.replicatedWorkspace.capability}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(request),
  });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
};
if (input.expected === 'stopped') {
  const pending = fetch(`${payload.replicatedWorkspace.endpoint}/execute`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${payload.replicatedWorkspace.capability}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(request),
  });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const stop = await fetch(`${payload.replicatedWorkspace.endpoint}/quiesce`, {
    method: 'POST',
    headers: { authorization: `Bearer ${payload.replicatedWorkspace.capability}` },
  });
  assert.equal(stop.status, 200, await stop.text());
  assert.equal((await pending).status, 409);
  console.log('PROOF_EXECUTOR_OK');
  process.exit(0);
}
const result = input.expected === 'no-tools' ? { noTools: true } : await invoke();
if (!result.noTools) {
  assert.deepEqual(await invoke(), result);
  assert.equal(result.exitCode, input.expectedExit ?? 0, result.output);
  if (input.expected !== 'either') assert.equal(result.outcome.status, input.expected);
}
await mkdir('/home/agor/.claude/projects/-workspace', { recursive: true });
await writeFile(transcript, 'fixture transcript\n');
await writeFile('/home/agor/.claude/.credentials.json', 'fixture-must-not-be-persisted');
const finalized = await fetch(`${payload.replicatedWorkspace.endpoint}/finalize`, {
  method: 'POST',
  headers: { authorization: `Bearer ${payload.replicatedWorkspace.capability}` },
});
assert.equal(finalized.status, 200, await finalized.text());
console.log(`PROOF_RESULT=${JSON.stringify(result)}`);
console.log('PROOF_EXECUTOR_OK');
