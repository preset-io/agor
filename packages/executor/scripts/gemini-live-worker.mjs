import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openSmokeState } from './gemini-live-state.mjs';

// One process per task, including follow-ups. Key arrives over private IPC,
// never argv or a credential file. Do not forward raw errors to the runner.
const abortController = new AbortController();
process.on('message', async (message) => {
  if (message === 'stop') {
    abortController.abort();
    return;
  }
  if (message?.type !== 'run') return;
  let state;
  try {
    assert.equal(process.env.GITHUB_SHA, undefined);
    assert.equal(process.env.SURFACE, undefined);
    state = await openSmokeState(message.packageRoot, message.root);
    const { executeGeminiTask } = await import(
      pathToFileURL(join(message.packageRoot, 'dist/executor/handlers/sdk/gemini.js')).href
    );
    await executeGeminiTask({
      client: state.client(message.apiKey),
      sessionId: message.sessionId,
      taskId: message.taskId,
      prompt: message.prompt,
      permissionMode: message.permissionMode,
      abortController,
    });
    state.close();
    process.exit(0);
  } catch {
    state?.close();
    process.exit(1);
  }
});
