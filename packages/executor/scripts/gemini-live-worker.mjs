import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as https from 'node:https';
import { createRequire } from 'node:module';
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
    if (message.offlineProbe) {
      const refuseNetwork = () => {
        throw new Error('Network forbidden in offline packaged probe');
      };
      globalThis.fetch = refuseNetwork;
      for (const transport of [http, https])
        Object.assign(transport.default, {
          request: refuseNetwork,
          get: refuseNetwork,
        });
      const require = createRequire(join(message.packageRoot, 'package.json'));
      const { loadManagedAgenticToolSdk } = await import(
        pathToFileURL(require.resolve('@agor/core/agentic-integrations')).href
      );
      // Match the adapter's import boundary before inspecting the pinned SDK.
      delete process.env.GEMINI_DEBUG_LOG_FILE;
      const sdk = await loadManagedAgenticToolSdk('gemini');
      const refreshAuth = sdk.Config.prototype.refreshAuth;
      sdk.Config.prototype.getMaxAttempts = () => 1;
      sdk.Config.prototype.refreshAuth = async function (...args) {
        await refreshAuth.apply(this, args);
        let turn = 0;
        this.getContentGenerator().generateContentStream = async () => {
          if (message.offlineProbe === 'failure' && turn++ > 0)
            throw Object.assign(new Error('PRIVATE_PROVIDER_MARKER API_KEY_INVALID'), {
              status: 400,
            });
          return (async function* () {
            yield {
              functionCalls:
                message.offlineProbe === 'failure'
                  ? [{ name: 'read_file', args: { file_path: 'source.txt' } }]
                  : undefined,
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts:
                      message.offlineProbe === 'failure'
                        ? [
                            {
                              functionCall: {
                                name: 'read_file',
                                args: { file_path: 'source.txt' },
                              },
                            },
                          ]
                        : [{ text: 'offline packaged response' }],
                  },
                  finishReason: 'STOP',
                },
              ],
              usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3, totalTokenCount: 14 },
              modelVersion: 'gemini-3.8-flash',
            };
          })();
        };
      };
    }
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
