import { describe, expect, it } from 'vitest';
import { EnvironmentCommandOutputCapture } from './environment-command-output';

function capture(options: {
  stdoutChunks: string[];
  stderrChunks?: string[];
  parseLifecycleResult?: boolean;
}) {
  let streamedStdout = '';
  let streamedStderr = '';
  const output = new EnvironmentCommandOutputCapture({
    parseLifecycleResult: options.parseLifecycleResult ?? true,
    stdout: { write: (value) => (streamedStdout += value) },
    stderr: { write: (value) => (streamedStderr += value) },
  });
  for (const chunk of options.stdoutChunks) output.writeStdout(chunk);
  for (const chunk of options.stderrChunks ?? []) output.writeStderr(chunk);
  return { ...output.finish(), streamedStdout, streamedStderr };
}

describe('EnvironmentCommandOutputCapture', () => {
  it('parses a chunk-split typed multi-URL result and suppresses it from all output', () => {
    const encoded = JSON.stringify({
      version: 1,
      access_urls: [
        { name: 'Shell', url: 'https://shell.example.test' },
        { name: 'Manager', url: 'https://manager.example.test' },
      ],
      health_url: 'https://shell.example.test/health',
      resource: { provider: 'github-codespaces', id: '123', name: 'space' },
    });
    const result = capture({
      stdoutChunks: [
        'building\nAGOR_ENVIRON',
        `MENT_RESULT=${encoded.slice(0, 25)}`,
        encoded.slice(25),
      ],
      stderrChunks: ['diagnostic\n'],
    });

    expect(result.lifecycleResult?.access_urls).toEqual([
      { name: 'Shell', url: 'https://shell.example.test/' },
      { name: 'Manager', url: 'https://manager.example.test/' },
    ]);
    expect(result.facts).toMatchObject({
      url: 'https://shell.example.test/',
      url_manager: 'https://manager.example.test/',
      name: 'space',
    });
    expect(result.streamedStdout).toBe('building\n');
    expect(result.streamedStderr).toBe('diagnostic\n');
    expect(result.output).not.toContain('AGOR_ENVIRONMENT_RESULT');
  });

  it('accepts the bounded legacy Preset keys and converts them to the typed result', () => {
    const result = capture({
      stdoutChunks: [
        'AGOR_FACT name=space\nAGOR_FACT url=https://shell.example.test\n',
        'AGOR_FACT url_manager=https://manager.example.test\n',
        'AGOR_FACT health=https://shell.example.test/health\nready\n',
      ],
    });
    expect(result.lifecycleResult).toMatchObject({
      version: 1,
      access_urls: [
        { name: 'App', url: 'https://shell.example.test/' },
        { name: 'Manager', url: 'https://manager.example.test/' },
      ],
      resource: { name: 'space' },
    });
    expect(result.streamedStdout).toBe('ready\n');
  });

  it.each([
    [
      'duplicate result',
      ['AGOR_ENVIRONMENT_RESULT={"version":1}\nAGOR_ENVIRONMENT_RESULT={"version":1}\n'],
    ],
    ['mixed protocols', ['AGOR_FACT name=space\nAGOR_ENVIRONMENT_RESULT={"version":1}\n']],
    ['unknown result field', ['AGOR_ENVIRONMENT_RESULT={"version":1,"token":"secret"}\n']],
    ['unsupported legacy fact', ['AGOR_FACT token=secret\n']],
    ['duplicate legacy fact', ['AGOR_FACT name=one\nAGOR_FACT name=two\n']],
  ])('fails closed for %s', (_name, stdoutChunks) => {
    expect(() => capture({ stdoutChunks })).toThrow();
  });

  it('treats a stderr control-looking line as visible diagnostics, never as a result', () => {
    const result = capture({
      stdoutChunks: ['ordinary\n'],
      stderrChunks: ['AGOR_ENVIRONMENT_RESULT={"version":1}\n'],
    });
    expect(result.lifecycleResult).toBeUndefined();
    expect(result.streamedStderr).toContain('AGOR_ENVIRONMENT_RESULT');
  });

  it('bounds an ordinary unterminated output line without confusing its tail for a control line', () => {
    const result = capture({ stdoutChunks: ['x'.repeat(150_000)] });
    expect(result.lifecycleResult).toBeUndefined();
    expect(result.output?.length).toBeLessThan(101_000);
    expect(result.output).toContain('environment output truncated');
  });

  it('does not parse controls when lifecycle parsing is disabled', () => {
    const result = capture({
      parseLifecycleResult: false,
      stdoutChunks: ['AGOR_FACT synced_sha=abc\n'],
    });
    expect(result.lifecycleResult).toBeUndefined();
    expect(result.streamedStdout).toBe('AGOR_FACT synced_sha=abc\n');
  });
});
