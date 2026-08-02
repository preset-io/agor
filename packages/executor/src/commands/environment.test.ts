import { describe, expect, it } from 'vitest';
import { parseAgorFacts } from './environment.js';

describe('parseAgorFacts', () => {
  it('returns an empty object for empty/undefined output', () => {
    expect(parseAgorFacts(undefined)).toEqual({});
    expect(parseAgorFacts('')).toEqual({});
    expect(parseAgorFacts('no facts here\njust logs\n')).toEqual({});
  });

  it('parses a single AGOR_FACT line', () => {
    expect(parseAgorFacts('AGOR_FACT url=https://foo-8080.app.github.dev')).toEqual({
      url: 'https://foo-8080.app.github.dev',
    });
  });

  it('parses multiple facts interleaved with build output', () => {
    const output = [
      'Resuming codespace...',
      'AGOR_FACT name=cuddly-fiesta-75jrjw954wxfxwx7',
      'ports set public',
      'AGOR_FACT url=https://cuddly-fiesta-8080.app.github.dev',
      'done',
    ].join('\n');
    expect(parseAgorFacts(output)).toEqual({
      name: 'cuddly-fiesta-75jrjw954wxfxwx7',
      url: 'https://cuddly-fiesta-8080.app.github.dev',
    });
  });

  it('trims surrounding whitespace and tolerates leading indentation', () => {
    expect(parseAgorFacts('   AGOR_FACT   url=https://x.dev   ')).toEqual({
      url: 'https://x.dev',
    });
  });

  it('lets a later line override an earlier one (last write wins)', () => {
    expect(parseAgorFacts('AGOR_FACT url=https://old.dev\nAGOR_FACT url=https://new.dev')).toEqual({
      url: 'https://new.dev',
    });
  });

  it('preserves = characters inside the value (e.g. query strings)', () => {
    expect(parseAgorFacts('AGOR_FACT url=https://x.dev/cb?a=1&b=2')).toEqual({
      url: 'https://x.dev/cb?a=1&b=2',
    });
  });

  it('ignores lines where AGOR_FACT is not at the start of the token stream', () => {
    // A log line merely mentioning AGOR_FACT mid-sentence must not be parsed.
    expect(parseAgorFacts('echo "will print AGOR_FACT url=nope"')).toEqual({});
  });

  it('rejects keys with characters outside [A-Za-z0-9_]', () => {
    expect(parseAgorFacts('AGOR_FACT my-key=value')).toEqual({});
    expect(parseAgorFacts('AGOR_FACT valid_key=value')).toEqual({ valid_key: 'value' });
  });
});
