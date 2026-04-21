import { describe, expect, it } from 'vitest';
import { buildExecutorEnvForPayload, isCodexPromptPayload } from './spawn-executor.js';

describe('isCodexPromptPayload', () => {
  it('recognizes Codex prompt payloads', () => {
    expect(
      isCodexPromptPayload({
        command: 'prompt',
        params: { tool: 'codex' },
      })
    ).toBe(true);
  });

  it('ignores non-Codex payloads', () => {
    expect(
      isCodexPromptPayload({
        command: 'prompt',
        params: { tool: 'claude' },
      })
    ).toBe(false);
  });
});

describe('buildExecutorEnvForPayload', () => {
  it('scrubs OPENAI_API_KEY for Codex payloads', () => {
    expect(
      buildExecutorEnvForPayload(
        { command: 'prompt', params: { tool: 'codex' } },
        {
          OPENAI_API_KEY: 'sk-test',
          PATH: '/usr/bin',
        }
      )
    ).toEqual({
      PATH: '/usr/bin',
    });
  });

  it('keeps OPENAI_API_KEY for non-Codex payloads', () => {
    expect(
      buildExecutorEnvForPayload(
        { command: 'prompt', params: { tool: 'claude' } },
        {
          OPENAI_API_KEY: 'sk-test',
          PATH: '/usr/bin',
        }
      )
    ).toEqual({
      OPENAI_API_KEY: 'sk-test',
      PATH: '/usr/bin',
    });
  });

  it('adds DAEMON_URL for local executor spawns while scrubbing Codex auth', () => {
    expect(
      buildExecutorEnvForPayload(
        { command: 'prompt', params: { tool: 'codex' } },
        {
          OPENAI_API_KEY: 'sk-test',
          PATH: '/usr/bin',
        },
        { daemonUrl: 'http://daemon.test:3030' }
      )
    ).toEqual({
      DAEMON_URL: 'http://daemon.test:3030',
      PATH: '/usr/bin',
    });
  });

  it('keeps the impersonated env minimal while still scrubbing Codex auth', () => {
    expect(
      buildExecutorEnvForPayload(
        { command: 'prompt', params: { tool: 'codex' } },
        {
          OPENAI_API_KEY: 'sk-test',
          PATH: '/usr/bin',
          NODE_ENV: 'test',
          EXTRA_VAR: 'ignored',
        },
        { daemonUrl: 'http://daemon.test:3030', asUser: 'alice' }
      )
    ).toEqual({
      DAEMON_URL: 'http://daemon.test:3030',
      NODE_ENV: 'test',
      PATH: '/usr/bin',
    });
  });
});
