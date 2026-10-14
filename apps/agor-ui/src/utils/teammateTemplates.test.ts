import { loadCatalog } from '@agor/core/mcp-catalog';
import { isCatalogEntryVisible } from '@agor/core/mcp-catalog/query';
import { describe, expect, it } from 'vitest';
import { AVATAR_PALETTE } from './avatarPalette';
import {
  BLANK_TEMPLATE,
  BLANK_TEMPLATE_ID,
  galleryCardsForFilter,
  getCategoryColor,
  getTeammateTemplate,
  getTemplateBySourceBranch,
  getTemplateForFrameworkSource,
  resolveTemplateSourceBranch,
  resolveTemplateSourceRemoteUrl,
  sortToolsForTemplate,
  TEAMMATE_GALLERY_CARDS,
  TEAMMATE_TEMPLATES,
  TEMPLATE_CATEGORIES,
} from './teammateTemplates';

describe('TEAMMATE_TEMPLATES', () => {
  it('lists the blank starter, then prompt-only and branch templates, in display order', () => {
    expect(TEAMMATE_GALLERY_CARDS.map((t) => t.id)).toEqual([
      BLANK_TEMPLATE_ID,
      'personal-assistant',
      'researcher',
      'engineering-assistant',
      'builder',
      'product-manager',
      'chief-of-staff',
      'competitive-analyst',
      'financial-analyst',
      'deal-desk',
      'sales-outbound',
      'legal-analyst',
    ]);
    for (const template of TEAMMATE_GALLERY_CARDS) {
      expect(template.title).toMatch(/^[A-Z][a-z ]+$/); // sentence case
      expect(template.description.length).toBeLessThanOrEqual(60);
      expect(template.emoji.length).toBeGreaterThan(0);
      expect(typeof template.icon).toBe('object');
    }
  });

  it('gives prompt-only templates a remit and no branch, and branch templates no remit', () => {
    for (const template of TEAMMATE_TEMPLATES) {
      if ('remit' in template) {
        expect(template).not.toHaveProperty('sourceBranch');
        expect(template.remit).toMatch(/^Desired outcome: .+ A first win is .+\.$/);
        expect(resolveTemplateSourceBranch(template.id)).toBeUndefined();
        expect(resolveTemplateSourceRemoteUrl(template.id)).toBeUndefined();
      } else {
        // The agor-teammate repo keys off these exact names.
        expect(template.sourceBranch).toMatch(/^template\//);
        expect(template.sourceRemoteUrl).toBe('https://github.com/preset-io/agor-teammate.git');
      }
    }
    expect(TEAMMATE_TEMPLATES.filter((t) => 'remit' in t).map((t) => t.id)).toEqual([
      'personal-assistant',
      'researcher',
      'engineering-assistant',
    ]);
  });

  it('qualifies real template refs with their source remote but leaves blank on the destination', () => {
    expect(resolveTemplateSourceRemoteUrl('deal-desk')).toBe(
      'https://github.com/preset-io/agor-teammate.git'
    );
    expect(resolveTemplateSourceRemoteUrl(BLANK_TEMPLATE_ID)).toBeUndefined();
    expect(resolveTemplateSourceRemoteUrl()).toBeUndefined();
  });

  it('pins the exact source-branch contract names', () => {
    expect(
      TEAMMATE_TEMPLATES.flatMap((t) => ('sourceBranch' in t ? [t.sourceBranch] : []))
    ).toEqual([
      'template/builder',
      'template/product-manager',
      'template/chief-of-staff',
      'template/competitive-analyst',
      'template/financial-analyst',
      'template/deal-desk-revops-analyst',
      'template/sales-outbound-analyst',
      'template/legal-analyst',
    ]);
  });

  it('gives each template a distinct emoji (Chief of staff must not reuse 🧭)', () => {
    const emojis = TEAMMATE_TEMPLATES.map((t) => t.emoji);
    expect(new Set(emojis).size).toBe(emojis.length);
    expect(TEAMMATE_TEMPLATES.find((t) => t.id === 'chief-of-staff')?.emoji).toBe('🗂️');
    expect(TEAMMATE_TEMPLATES.find((t) => t.id === 'product-manager')?.emoji).toBe('🧭');
  });

  it('puts the blank starter first in the gallery cards, never in the templates', () => {
    expect(TEAMMATE_GALLERY_CARDS).toHaveLength(12);
    expect(TEAMMATE_GALLERY_CARDS[0]).toBe(BLANK_TEMPLATE);
    expect(BLANK_TEMPLATE.title).toBe('Start from scratch');
    expect(BLANK_TEMPLATE.description).toBe('A blank teammate you shape as you chat.');
    expect(TEAMMATE_TEMPLATES).not.toContain(BLANK_TEMPLATE);
  });
});

describe('categories', () => {
  it('buckets every template into grow/build/operate and leaves blank uncategorized', () => {
    const byCategory = (id: string) => TEAMMATE_TEMPLATES.find((t) => t.id === id)?.category;
    expect(byCategory('competitive-analyst')).toBe('grow');
    expect(byCategory('deal-desk')).toBe('grow');
    expect(byCategory('sales-outbound')).toBe('grow');
    expect(byCategory('product-manager')).toBe('build');
    expect(byCategory('builder')).toBe('build');
    expect(byCategory('chief-of-staff')).toBe('operate');
    expect(byCategory('financial-analyst')).toBe('operate');
    expect(byCategory('legal-analyst')).toBe('operate');
    expect(byCategory('personal-assistant')).toBe('operate');
    expect(byCategory('researcher')).toBe('grow');
    expect(byCategory('engineering-assistant')).toBe('build');
    // Every real template has a category; the blank starter has none.
    expect(TEAMMATE_TEMPLATES.every((t) => t.category)).toBe(true);
    expect(BLANK_TEMPLATE.category).toBeUndefined();
  });

  it('defines the three categories and colors them from the shared avatar palette', () => {
    expect(TEMPLATE_CATEGORIES.map((c) => c.id)).toEqual(['grow', 'build', 'operate']);
    expect(TEMPLATE_CATEGORIES.map((c) => c.label)).toEqual(['Grow', 'Build', 'Operate']);
    for (const category of TEMPLATE_CATEGORIES) {
      // Reused, never invented: each color is an entry of AVATAR_PALETTE.
      expect(AVATAR_PALETTE).toContain(category.color);
    }
    // Distinct hue per category.
    expect(new Set(TEMPLATE_CATEGORIES.map((c) => c.color)).size).toBe(3);
  });

  it('getCategoryColor resolves a palette color per category and undefined otherwise', () => {
    expect(getCategoryColor('grow')).toBe(AVATAR_PALETTE[2]);
    expect(getCategoryColor('build')).toBe(AVATAR_PALETTE[6]);
    expect(getCategoryColor('operate')).toBe(AVATAR_PALETTE[5]);
    expect(getCategoryColor(undefined)).toBeUndefined();
  });
});

describe('galleryCardsForFilter', () => {
  it('All view lists the blank starter first, then every template in display order', () => {
    const ids = galleryCardsForFilter('all').map((t) => t.id);
    expect(ids).toEqual([BLANK_TEMPLATE_ID, ...TEAMMATE_TEMPLATES.map((t) => t.id)]);
  });

  it('a category filter returns only that category in default order, no blank', () => {
    const ids = galleryCardsForFilter('grow').map((t) => t.id);
    expect(ids).toEqual(['researcher', 'competitive-analyst', 'deal-desk', 'sales-outbound']);
  });
});

describe('getTeammateTemplate', () => {
  it('resolves known ids (including blank) and returns undefined otherwise', () => {
    expect(getTeammateTemplate('legal-analyst')?.title).toBe('Legal analyst');
    expect(getTeammateTemplate(BLANK_TEMPLATE_ID)).toBe(BLANK_TEMPLATE);
    expect(getTeammateTemplate('nope')).toBeUndefined();
    expect(getTeammateTemplate(null)).toBeUndefined();
  });
});

describe('resolveTemplateSourceBranch', () => {
  it('forces a real template branch, defers blank/none, and rejects stale ids', () => {
    expect(resolveTemplateSourceBranch('deal-desk')).toBe('template/deal-desk-revops-analyst');
    expect(resolveTemplateSourceBranch(BLANK_TEMPLATE_ID)).toBeUndefined();
    expect(resolveTemplateSourceBranch(null)).toBeUndefined();
    expect(() => resolveTemplateSourceBranch('nope')).toThrow('Unknown teammate template id: nope');
  });
});

describe('getTemplateBySourceBranch', () => {
  it('recovers the template from its contract source branch', () => {
    expect(getTemplateBySourceBranch('template/legal-analyst')?.id).toBe('legal-analyst');
    expect(getTemplateBySourceBranch('template/deal-desk-revops-analyst')?.id).toBe('deal-desk');
    // Round-trips with resolveTemplateSourceBranch for every branch template.
    for (const template of TEAMMATE_TEMPLATES) {
      if (!('sourceBranch' in template)) continue;
      expect(getTemplateBySourceBranch(template.sourceBranch)?.id).toBe(template.id);
    }
  });

  it('treats blank/main and empty input as "no template"', () => {
    expect(getTemplateBySourceBranch(BLANK_TEMPLATE.sourceBranch)).toBeUndefined(); // 'main'
    expect(getTemplateBySourceBranch('main')).toBeUndefined();
    expect(getTemplateBySourceBranch('  ')).toBeUndefined();
    expect(getTemplateBySourceBranch('')).toBeUndefined();
    expect(getTemplateBySourceBranch(null)).toBeUndefined();
    expect(getTemplateBySourceBranch(undefined)).toBeUndefined();
  });

  it('returns undefined for an unrecognized branch', () => {
    expect(getTemplateBySourceBranch('feature/whatever')).toBeUndefined();
  });
});

describe('getTemplateForFrameworkSource', () => {
  it('recovers a template only for the detected framework repository', () => {
    expect(
      getTemplateForFrameworkSource({
        sourceBranch: 'template/legal-analyst',
        selectedRepoId: 'repo-framework',
        frameworkRepoId: 'repo-framework',
      })?.id
    ).toBe('legal-analyst');

    expect(
      getTemplateForFrameworkSource({
        sourceBranch: 'template/legal-analyst',
        selectedRepoId: 'repo-unrelated',
        frameworkRepoId: 'repo-framework',
      })
    ).toBeUndefined();
    expect(
      getTemplateForFrameworkSource({
        sourceBranch: 'template/legal-analyst',
        selectedRepoId: 'repo-framework',
        frameworkRepoId: undefined,
      })
    ).toBeUndefined();
  });
});

describe('sortToolsForTemplate', () => {
  // Curated order, as the tools wall receives it.
  const catalog = [
    { name: 'io.github.github/github-mcp-server', category: 'dev-tools' },
    { name: 'app.linear/linear', category: 'dev-tools' },
    { name: 'com.supabase/mcp', category: 'data-storage' },
    { name: 'com.notion/mcp', category: 'productivity' },
    { name: 'com.datadoghq/mcp', category: 'observability' },
    { name: 'com.stripe/mcp', category: 'productivity' },
    { name: 'ai.exa/exa', category: 'search' },
    { name: 'com.paypal.mcp/mcp', category: 'productivity' },
    { name: 'com.airtable/mcp', category: 'data-storage' },
  ] as const;
  const names = (entries: readonly { name: string }[]) => entries.map((entry) => entry.name);

  it('keeps the curated order with no template or the blank starter', () => {
    expect(names(sortToolsForTemplate(catalog))).toEqual(names(catalog));
    expect(names(sortToolsForTemplate(catalog, BLANK_TEMPLATE))).toEqual(names(catalog));
  });

  it("lists the template's tools, then its categories, then the rest in curated order", () => {
    const financial = getTeammateTemplate('financial-analyst');
    expect(names(sortToolsForTemplate(catalog, financial))).toEqual([
      // preferredTools, in their own order (Preset is not in this fixture)
      'com.stripe/mcp',
      'com.paypal.mcp/mcp',
      // data-storage, then productivity, each in curated order
      'com.supabase/mcp',
      'com.airtable/mcp',
      'com.notion/mcp',
      // everything else, unchanged
      'io.github.github/github-mcp-server',
      'app.linear/linear',
      'com.datadoghq/mcp',
      'ai.exa/exa',
    ]);
  });

  it('sorts without dropping, adding or mutating entries', () => {
    const input = [...catalog];
    for (const template of TEAMMATE_GALLERY_CARDS) {
      const sorted = sortToolsForTemplate(input, template);
      expect([...names(sorted)].sort()).toEqual([...names(catalog)].sort());
    }
    expect(names(input)).toEqual(names(catalog));
  });

  it('names only tools the shipped catalog shows', async () => {
    const visible = new Set(
      (await loadCatalog()).filter(isCatalogEntryVisible).map((entry) => entry.name)
    );
    for (const template of TEAMMATE_TEMPLATES) {
      for (const tool of 'preferredTools' in template ? template.preferredTools : []) {
        expect(visible, `${template.id} → ${tool}`).toContain(tool);
      }
    }
  });
});
