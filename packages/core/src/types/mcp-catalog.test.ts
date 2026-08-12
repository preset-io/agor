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

  it('reads the same identity segment out of the name as the slug does', () => {
    // One rule, two formattings. Drift here is what produced `mcp__mcp__<tool>`.
    // Asserted as "both track the name", not as an equality between the two
    // outputs: they coincide only for an untitled entry, and reading that
    // coincidence as the contract is how `title` ends up feeding the slug.
    for (const name of [
      'com.deepwiki/mcp',
      'io.github.github/github-mcp-server',
      'io.sanity.www/mcp',
    ]) {
      expect(catalogDisplayName({ name }).toLowerCase()).toBe(catalogServerSlug(name));
    }

    // A different publisher moves both.
    expect(catalogServerSlug('com.other/mcp')).not.toBe(catalogServerSlug('com.deepwiki/mcp'));
    expect(catalogDisplayName({ name: 'com.other/mcp' })).not.toBe(
      catalogDisplayName({ name: 'com.deepwiki/mcp' })
    );
  });

  it('lets a curated title move the screen label without moving the tool namespace', () => {
    // `curated.yaml` accepts `title`, and `deriveSharedColumns` prefers
    // `curation.title ?? registry.title` — a live path, not a hypothetical. The
    // slug is an agent-visible namespace: editing display copy must never
    // rename the tools a running session already knows.
    const name = 'com.deepwiki/mcp';

    expect(catalogDisplayName({ name })).toBe('Deepwiki');
    expect(catalogDisplayName({ name, title: 'DeepWiki' })).toBe('DeepWiki');
    expect(catalogDisplayName({ name, title: 'Devin Wiki Search' })).toBe('Devin Wiki Search');

    // Same name, three labels, one namespace.
    expect(catalogServerSlug(name)).toBe('deepwiki');
  });
});
