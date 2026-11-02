import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { featureAnnouncementHighlightsSchema } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  FEATURE_ANNOUNCEMENT_HIGHLIGHTS_PATH,
  parseFeatureAnnouncements,
} from './feature-announcements';
import { clip, parseChangelogFeatureAnnouncements } from './feature-announcements-changelog';

const CHANGELOG = `# Changelog

## Style

- **Features** — user-visible new capabilities

## Unreleased

### Features

- **Not shipped yet** — still in review ([#9000](https://github.com/preset-io/agor/pull/9000))

## 0.2.0 (2026-10-13)

Release preparation covers merged changes.

### Features

- **Zone layouts** — zones arrange cards in a row, column or grid. Pick one from the toolbar. ([#3135](https://github.com/preset-io/agor/pull/3135), [#3136](https://github.com/preset-io/agor/pull/3136))
  - Cards keep their order.
  - Agents can set it with \`agor_boards_update\`.
- **Second feature** - plain hyphen separator ([#3200](https://github.com/preset-io/agor/pull/3200))

### Chores

- **Bump deps** — internal ([#3201](https://github.com/preset-io/agor/pull/3201))

### Security

- **Safer links** — see [the guide](https://agor.live/guide/security) ([#3202](https://github.com/preset-io/agor/pull/3202))

## 0.1.1 (skipped)

## [0.1.0](https://github.com/preset-io/agor/commit/abc) (2026-09-01)

### Breaking

- **Removed strict mode** — use sandbox ([#100](https://github.com/preset-io/agor/pull/100))

### Fixes

- **A fix** — fixed ([#101](https://github.com/preset-io/agor/pull/101))
`;

describe('parseChangelogFeatureAnnouncements', () => {
  it('ships dated releases newest first and skips Unreleased, Chores and undated headings', () => {
    const releases = parseChangelogFeatureAnnouncements(CHANGELOG);

    expect(releases.map((r) => [r.id, r.label, r.version_label, r.published_at])).toEqual([
      ['oss-0.2.0', '0.2.0', 'Agor 0.2.0', '2026-10-13T00:00:00.000Z'],
      ['oss-0.1.0', '0.1.0', 'Agor 0.1.0', '2026-09-01T00:00:00.000Z'],
    ]);
    // Features are new and ring the bell; the rest are quiet improvements.
    expect(releases[0].items.map((item) => [item.title, item.kind, item.badge])).toEqual([
      ['Zone layouts', 'new', true],
      ['Second feature', 'new', true],
      ['Safer links', 'improved', false],
    ]);
    expect(releases[1].items.map((item) => item.kind)).toEqual(['improved', 'improved']);
  });

  it('keeps the first sentence as the one line and moves PR links into pr_numbers', () => {
    const [zones] = parseChangelogFeatureAnnouncements(CHANGELOG)[0].items;

    expect(zones).toMatchObject({
      id: 'oss-0.2.0-pr3135',
      one_line: 'Zones arrange cards in a row, column or grid.',
      roles: 'everyone',
      popup: false,
      visual: null,
      button: null,
      tenant_ids: null,
      pr_numbers: [3135, 3136],
      new_until: '2026-11-12T00:00:00.000Z',
      agent_brief:
        'Zone layouts. Zones arrange cards in a row, column or grid. Pick one from the toolbar.',
    });
  });

  it('applies a highlight by PR number', () => {
    const [zones, second] = parseChangelogFeatureAnnouncements(CHANGELOG, {
      '3136': {
        title: 'Zones can arrange your cards',
        popup: true,
        visual: { type: 'illustration', key: 'zone-grid' },
        button: { action: 'agor_page', target: 'board', label: 'See it on my board' },
      },
    })[0].items;

    expect(zones).toMatchObject({
      title: 'Zones can arrange your cards',
      popup: true,
      visual: { type: 'illustration', key: 'zone-grid' },
      button: { action: 'agor_page', target: 'board' },
    });
    expect(second.popup).toBe(false);
  });

  it('keys items by PR and applies a highlight to one entry, preferring Features', () => {
    const changelog = `## 0.3.0 (2026-10-20)

### Fixes

- **Zone fix** — fixed ([#3135](https://github.com/preset-io/agor/pull/3135))
- **No PR** — an entry without a link

### Features

- **Zone layouts** — zones arrange cards ([#3135](https://github.com/preset-io/agor/pull/3135))
- **Same PR again** — a second entry citing it ([#3135](https://github.com/preset-io/agor/pull/3135))
`;
    const [release] = parseChangelogFeatureAnnouncements(changelog, {
      '3135': { title: 'Zones can arrange your cards', popup: true },
    });

    expect(release.items.map((item) => [item.id, item.title, item.popup])).toEqual([
      ['oss-0.3.0-pr3135', 'Zone fix', false],
      ['oss-0.3.0-2', 'No PR', false],
      ['oss-0.3.0-3', 'Zones can arrange your cards', true],
      ['oss-0.3.0-4', 'Same PR again', false],
    ]);
  });

  it('limits the number of releases', () => {
    expect(parseChangelogFeatureAnnouncements(CHANGELOG, {}, 1).map((r) => r.label)).toEqual([
      '0.2.0',
    ]);
  });

  it('turns the repository CHANGELOG and highlights into valid releases', () => {
    const root = join(__dirname, '..', '..', '..', '..');
    const highlights = featureAnnouncementHighlightsSchema.parse(
      JSON.parse(readFileSync(join(root, FEATURE_ANNOUNCEMENT_HIGHLIGHTS_PATH), 'utf8'))
    );
    const raw = parseChangelogFeatureAnnouncements(
      readFileSync(join(root, 'CHANGELOG.md'), 'utf8'),
      highlights.items
    );
    // Every parsed item passes the delivery gate: nothing is silently dropped.
    const parsed = parseFeatureAnnouncements(raw);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.flatMap((r) => r.items)).toHaveLength(raw.flatMap((r) => r.items).length);
  });
});

describe('clip', () => {
  it('keeps short text and cuts long text on a word boundary', () => {
    expect(clip('Short brief.', 160)).toBe('Short brief.');
    const cut = clip('Zones have a layout, Free, Row, Column or Grid.', 30);
    expect(cut).toBe('Zones have a layout, Free…');
    expect(cut.length).toBeLessThanOrEqual(30);
  });
});
