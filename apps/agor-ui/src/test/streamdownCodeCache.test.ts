// biome-ignore-all lint/plugin/noHardcodedColorLiteral: custom syntax themes are test fixtures
import {
  type CodeHighlighterPlugin,
  clearHighlightCache,
  code,
  createCodePlugin,
  type HighlightOptions,
  type HighlightResult,
} from '@streamdown/code';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const themes: HighlightOptions['themes'] = ['github-light', 'github-dark'];
const options = (source: string, language = 'typescript'): HighlightOptions => ({
  code: source,
  language: language as HighlightOptions['language'],
  themes,
});
function highlight(input: HighlightOptions, plugin: CodeHighlighterPlugin = code) {
  return new Promise<HighlightResult>((resolve) => {
    const result = plugin.highlight(input, resolve);
    if (result) resolve(result);
  });
}
function syntheticCode(length: number) {
  let source = '';
  for (let i = 0; source.length < length; i++) {
    source += `${i ? '\n' : ''}const value${i} = compute(${i}, "s${i}") + ${i * 2}; // c${i}`;
  }
  return source.slice(0, length);
}
const text = (result: HighlightResult) =>
  result.tokens.map((line) => line.map((token) => token.content).join('')).join('\n');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => clearHighlightCache());
afterEach(() => {
  clearHighlightCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Pins the installed pnpm patch used by richContentPlugins, not a host wrapper
// that would still fill upstream's unbounded module cache.
describe('Streamdown code result retention', () => {
  it('evicts realistic streaming prefixes across consumers and plugin instances', {
    timeout: 60_000,
  }, async () => {
    const source = syntheticCode(10_240);
    // No retained result/callback array: each consumer goes away after delivery.
    for (let end = 40; end <= source.length; end += 40) {
      await highlight(options(source.slice(0, end)), createCodePlugin());
    }
    expect(text(await highlight(options(source)))).toBe(source);
    // A second instance cannot create a second budget or recover evicted tokens.
    const other = createCodePlugin();
    expect(other.highlight(options(source))).not.toBeNull();
    expect(other.highlight(options(source.slice(0, 40)))).toBeNull();
    expect(other.highlight(options(source.slice(0, 5120)))).toBeNull();
    await settle();
  });

  it('uses recency as well as an aggregate token-weight budget', async () => {
    for (let i = 0; i < 32; i++) await highlight(options(`const tiny${i} = ${i};`));
    expect(code.highlight(options('const tiny0 = 0;'))).not.toBeNull();
    await highlight(options('const overflow = 32;'));
    expect(code.highlight(options('const tiny0 = 0;'))).not.toBeNull();
    expect(code.highlight(options('const tiny1 = 1;'))).toBeNull();
    await settle();
    clearHighlightCache();
    const source = syntheticCode(10_240);
    for (let i = 0; i < 16; i++) await highlight(options(`${source}\n// ${i}`));
    // Far fewer than 32 entries: weight, not count, must have forced eviction.
    expect(code.highlight(options(`${source}\n// 0`))).toBeNull();
    expect(code.highlight(options(`${source}\n// 15`))).not.toBeNull();
    await settle();
  });

  it('delivers but does not retain huge source or token-dense results', {
    timeout: 60_000,
  }, async () => {
    for (const source of ['x'.repeat(65_537), `${'0;'.repeat(100)}\n`.repeat(300)]) {
      expect(
        text(await highlight(options(source, source.startsWith('x') ? 'text' : 'typescript')))
      ).toBe(source);
      // The second source fits admission length but exceeds token weight.
      expect(
        code.highlight(options(source, source.startsWith('x') ? 'text' : 'typescript'))
      ).toBeNull();
      await settle();
    }
  });

  it('uses the whole content, not length plus first/last characters', async () => {
    const source = `${'// prefix\n'.repeat(20)}const value = 1;\n${'// suffix\n'.repeat(20)}`;
    const changed = source.replace('value = 1', 'value = 2');
    await highlight(options(source));
    expect(text(await highlight(options(changed)))).toBe(changed);
    expect(text(await highlight(options(source)))).toBe(source);
  });

  it('shares one async result and serves synchronous hits without re-notifying', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const input = options('const concurrent = 1;');
    expect(code.highlight(input, first)).toBeNull();
    expect(createCodePlugin().highlight(input, second)).toBeNull();
    await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(1));
    expect(first).toHaveBeenCalledExactlyOnceWith(second.mock.calls[0][0]);
    const cached = code.highlight(input, first);
    expect(cached).toBe(second.mock.calls[0][0]);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('isolates throwing subscribers and cleans up failed loads for retry', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = vi.fn(() => {
      throw new Error('consumer disposed');
    });
    const good = vi.fn();
    const input = options('const listeners = 1;');
    code.highlight(input, bad);
    code.highlight(input, good);
    await vi.waitFor(() => expect(good).toHaveBeenCalledTimes(1));
    expect(code.highlight(input)).toBe(good.mock.calls[0][0]);
    expect(log).toHaveBeenCalledTimes(1);

    const failed = {
      ...input,
      themes: ['missing-test-theme', 'github-dark'] as unknown as HighlightOptions['themes'],
    };
    const abandoned = vi.fn();
    code.highlight(failed, abandoned);
    code.highlight(failed, abandoned);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));
    code.highlight(failed, abandoned);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(3));
    expect(abandoned).not.toHaveBeenCalled();
  });

  it('cannot deliver or admit stale in-flight results after reset', async () => {
    const input = options('const reset = 1;');
    const old = vi.fn();
    const fresh = vi.fn();
    code.highlight(input, old);
    await Promise.resolve(); // Let the lazy loader start before invalidating its job.
    clearHighlightCache();
    code.highlight(input, fresh);
    await vi.waitFor(() => expect(fresh).toHaveBeenCalledTimes(1));
    expect(old).not.toHaveBeenCalled();
    expect(code.highlight(input)).toBe(fresh.mock.calls[0][0]);
    clearHighlightCache();
    code.highlight(input, clearHighlightCache);
    code.highlight(input, old);
    await settle();
    expect(old).not.toHaveBeenCalled();
    expect(code.highlight(input)).toBeNull();
    await settle();
  });

  it('does not reuse browser results or coalesce subscribers across SSR requests', async () => {
    const input = options('const request = 1;');
    await highlight(input);
    vi.stubGlobal('window', undefined);
    const first = vi.fn();
    const second = vi.fn();
    expect(code.highlight(input, first)).toBeNull();
    expect(code.highlight(input, second)).toBeNull();
    await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(1));
    expect(first.mock.calls[0][0]).not.toBe(second.mock.calls[0][0]);
    expect(code.highlight(input)).toBeNull();
    await settle();
  });

  it('preserves aliases, unknown-language fallback, configured and dual themes', async () => {
    const plugin = createCodePlugin({ themes: ['nord', 'github-dark'] });
    expect(plugin.getThemes()).toEqual(['nord', 'github-dark']);
    expect(plugin.getSupportedLanguages()).toContain('typescript');
    expect(plugin.supportsLanguage(' TS ' as HighlightOptions['language'])).toBe(true);
    expect(plugin.supportsLanguage('not-a-language' as HighlightOptions['language'])).toBe(false);
    const source = 'const color = "hello";';
    const ts = await highlight(options(source, ' TS '));
    expect(code.highlight(options(source, 'typescript'))).toBe(ts);
    expect(ts.tokens.flat().some((token) => token.htmlStyle?.['--shiki-dark'])).toBe(true);
    expect(text(await highlight(options(source, 'not-a-language')))).toBe(source);
    const nord = await highlight({ ...options(source), themes: plugin.getThemes() }, plugin);
    expect(nord).not.toEqual(ts);
    expect(text(await highlight(options('a: 1', 'yml')))).toBe('a: 1');
  });

  it('distinguishes same-name custom themes, including within a dual-theme pair', async () => {
    const light = {
      name: 'same-name',
      type: 'light' as const,
      colors: { 'editor.foreground': '#112233' },
      tokenColors: [],
    };
    const dark = {
      name: 'same-name',
      type: 'dark' as const,
      colors: { 'editor.foreground': '#aabbcc' },
      tokenColors: [],
    };
    const input = {
      ...options('plain', 'text'),
      themes: [light, dark] as HighlightOptions['themes'],
    };
    const original = await highlight(input);
    const swapped = await highlight({ ...input, themes: [dark, light] });
    expect(original.fg).not.toBe(swapped.fg);
    expect(original.fg).toContain('--shiki-dark:#aabbcc');
    expect(code.highlight(input)).toBe(original);
    const unnamed = await highlight({
      ...input,
      themes: [
        { ...light, name: undefined },
        { ...dark, name: undefined },
      ],
    });
    expect(unnamed.fg).toBe(original.fg);
  });
});
