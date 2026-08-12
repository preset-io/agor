import { describe, expect, it } from 'vitest';
import { catalogDisplayName, catalogServerSlug } from './mcp-catalog';

describe('catalogServerSlug', () => {
  it('names the publisher, not the protocol word the path usually carries', () => {
    // This is the `<name>` in every `mcp__<name>__<tool>` the model reads.
    expect(catalogServerSlug('com.deepwiki/mcp')).toBe('deepwiki');
    expect(catalogServerSlug('io.sentry/mcp')).toBe('sentry');
    expect(catalogServerSlug('io.github.github/github-mcp-server')).toBe('github');
  });

  it('skips a protocol subdomain to reach the publisher', () => {
    expect(catalogServerSlug('com.figma.mcp/mcp')).toBe('figma');
    expect(catalogServerSlug('io.sanity.www/mcp')).toBe('sanity');
  });

  it('keeps distinct publishers distinct — the whole point', () => {
    // The previous rule took the last path segment, so all of these were `mcp`
    // and two installs in one session produced indistinguishable tool names.
    const names = ['com.deepwiki/mcp', 'com.context7/mcp', 'io.sentry/mcp', 'com.slack/mcp'];
    expect(new Set(names.map(catalogServerSlug)).size).toBe(names.length);
  });

  it('falls back to the path segment when no publisher survives', () => {
    expect(catalogServerSlug('mcp/weather-tools')).toBe('weather-tools');
    expect(catalogServerSlug('mcp/mcp')).toBe('mcp-server');
  });

  it('produces a tool-namespace-safe slug', () => {
    expect(catalogServerSlug('com.Monday/monday.com')).toBe('monday');
    expect(catalogServerSlug('co.hugging_face/mcp')).toBe('hugging-face');
  });
});

describe('catalogDisplayName', () => {
  it('prefers a curated title', () => {
    expect(catalogDisplayName({ name: 'com.deepwiki/mcp', title: '  DeepWiki  ' })).toBe(
      'DeepWiki'
    );
  });

  it('stands the publisher in when the registry never supplied a title', () => {
    expect(catalogDisplayName({ name: 'com.deepwiki/mcp' })).toBe('Deepwiki');
    expect(catalogDisplayName({ name: 'com.figma.mcp/mcp' })).toBe('Figma');
  });

  it('keeps the registry name when nothing identifying is left', () => {
    expect(catalogDisplayName({ name: 'mcp/mcp' })).toBe('mcp/mcp');
  });

  it('agrees with the slug about which half is the identity', () => {
    // One rule, two formattings. Drift here is what produced `mcp__mcp__<tool>`.
    for (const name of [
      'com.deepwiki/mcp',
      'io.github.github/github-mcp-server',
      'io.sanity.www/mcp',
    ]) {
      expect(catalogServerSlug(name)).toBe(catalogDisplayName({ name }).toLowerCase());
    }
  });
});
