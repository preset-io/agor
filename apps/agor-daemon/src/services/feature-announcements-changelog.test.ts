import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FEATURE_ANNOUNCEMENTS_CSP_IMG_SRC } from '@agor/core/config';
import { describe, expect, it } from 'vitest';
import {
  FEATURE_ANNOUNCEMENT_HIGHLIGHTS_PATH,
  parseFeatureAnnouncements,
} from './feature-announcements';
import {
  type FeatureAnnouncementHighlight,
  parseChangelogFeatureAnnouncements,
} from './feature-announcements-changelog';

const CHANGELOG = `# Changelog

## Style

- **Features** — user-visible new capabilities

## Unreleased

### Features

- **Not shipped yet** — still in review ([#9000](https://github.com/preset-io/agor/pull/9000))

## 0.2.0 (2026-10-13)

Release preparation covers merged changes.

### Features

- **Zone layouts** — zones arrange cards in a row, column or grid ([#3135](https://github.com/preset-io/agor/pull/3135), [#3136](https://github.com/preset-io/agor/pull/3136))
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
    const notes = parseChangelogFeatureAnnouncements(CHANGELOG);

    expect(notes.map((note) => [note.id, note.version, note.published_at])).toEqual([
      ['oss-0.2.0', '0.2.0', '2026-10-13T00:00:00.000Z'],
      ['oss-0.1.0', '0.1.0', '2026-09-01T00:00:00.000Z'],
    ]);
    expect(notes[0].items.map((item) => [item.title, item.category, item.tier])).toEqual([
      ['Zone layouts', 'feature', 'update'],
      ['Second feature', 'feature', 'update'],
      ['Safer links', 'security', 'update'],
    ]);
    expect(notes[1].items.map((item) => item.category)).toEqual(['improvement', 'fix']);
  });

  it('keeps the entry text and details but moves PR links into pr_numbers', () => {
    const [zones] = parseChangelogFeatureAnnouncements(CHANGELOG)[0].items;

    expect(zones).toMatchObject({
      id: 'oss-0.2.0-1',
      audience: 'all',
      pr_numbers: [3135, 3136],
      body_md:
        'Zones arrange cards in a row, column or grid\n\n- Cards keep their order.\n- Agents can set it with `agor_boards_update`.',
      agent_brief: 'Zone layouts. Zones arrange cards in a row, column or grid',
    });
  });

  it('promotes an entry from the highlights sidecar by PR number', () => {
    const [zones, second] = parseChangelogFeatureAnnouncements(CHANGELOG, {
      items: {
        '3136': {
          tier: 'major',
          subtitle: 'Cards snap into place.',
          cta_label: 'See it on my board',
          cta_path: '/b/:currentBoard/',
        },
      },
    })[0].items;

    expect(zones).toMatchObject({
      tier: 'major',
      subtitle: 'Cards snap into place.',
      cta_path: '/b/:currentBoard/',
    });
    expect(second.tier).toBe('update');
  });

  it('limits the number of releases', () => {
    expect(
      parseChangelogFeatureAnnouncements(CHANGELOG, {}, 1).map((note) => note.version)
    ).toEqual(['0.2.0']);
  });

  it('turns the repository CHANGELOG and highlights into valid notes', () => {
    const root = join(__dirname, '..', '..', '..', '..');
    const notes = parseFeatureAnnouncements(
      parseChangelogFeatureAnnouncements(
        readFileSync(join(root, 'CHANGELOG.md'), 'utf8'),
        JSON.parse(readFileSync(join(root, FEATURE_ANNOUNCEMENT_HIGHLIGHTS_PATH), 'utf8'))
      )
    );

    expect(notes.length).toBeGreaterThan(0);
    // Highlight visuals must load under the default CSP img-src.
    const highlights = JSON.parse(
      readFileSync(join(root, FEATURE_ANNOUNCEMENT_HIGHLIGHTS_PATH), 'utf8')
    );
    for (const highlight of Object.values<FeatureAnnouncementHighlight>(highlights.items)) {
      for (const url of [highlight.visual_url, highlight.visual_url_dark]) {
        if (url) {
          expect(new URL(url).protocol).toBe('https:');
          expect(new URL(url).origin).toBe(FEATURE_ANNOUNCEMENTS_CSP_IMG_SRC);
        }
      }
    }
    expect(notes.every((note) => note.items.every((item) => item.title && item.body_md))).toBe(
      true
    );
  });
});
