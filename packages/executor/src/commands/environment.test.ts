import { describe, expect, it } from 'vitest';
import { parseEnvironmentCommandOutput } from './environment.js';

describe('parseEnvironmentCommandOutput', () => {
  it('extracts dynamic app/health URLs and removes the protocol line from persisted output', () => {
    const parsed = parseEnvironmentCommandOutput(
      [
        'Codespace is ready',
        'AGOR_ENVIRONMENT_RESULT={"app":"https://space-5000.app.github.dev","health":"https://space-3000.app.github.dev/health"}',
        '',
      ].join('\n')
    );

    expect(parsed.output).toBe('Codespace is ready\n');
    expect(parsed.environmentResult).toEqual({
      app: 'https://space-5000.app.github.dev/',
      health: 'https://space-3000.app.github.dev/health',
    });
  });

  it('accepts an empty optional result object', () => {
    expect(parseEnvironmentCommandOutput('AGOR_ENVIRONMENT_RESULT={}')).toEqual({
      output: '',
      environmentResult: {},
    });
  });

  it('leaves ordinary lifecycle output unchanged', () => {
    expect(parseEnvironmentCommandOutput('docker compose started\n')).toEqual({
      output: 'docker compose started\n',
    });
  });

  it.each([
    'AGOR_ENVIRONMENT_RESULT=not-json',
    'AGOR_ENVIRONMENT_RESULT={"app":"file:///tmp/app"}',
    'AGOR_ENVIRONMENT_RESULT={"app":"https://user:secret@example.test"}',
    'AGOR_ENVIRONMENT_RESULT={"health":"https://example.test?token=secret"}',
    'AGOR_ENVIRONMENT_RESULT={"app":"https://example.test","token":"secret"}',
  ])('rejects an invalid or over-broad result: %s', (output) => {
    expect(() => parseEnvironmentCommandOutput(output)).toThrow();
  });

  it('rejects ambiguous duplicate result lines', () => {
    const line = 'AGOR_ENVIRONMENT_RESULT={"app":"https://example.test"}';
    expect(() => parseEnvironmentCommandOutput(`${line}\n${line}`)).toThrow(
      'more than one result line'
    );
  });
});
