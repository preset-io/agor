import { describe, expect, it } from 'vitest';
import { AVATAR_PALETTE } from './avatarPalette';
import {
  BLANK_TEMPLATE,
  BLANK_TEMPLATE_ID,
  galleryCardsForFilter,
  getCategoryColor,
  getTeammateTemplate,
  getTemplateBySourceBranch,
  recommendedTemplateIds,
  resolveTemplateSourceBranch,
  TEAMMATE_GALLERY_CARDS,
  TEAMMATE_TEMPLATES,
  TEMPLATE_CATEGORIES,
} from './teammateTemplates';

describe('TEAMMATE_TEMPLATES', () => {
  it('defines the eight templates with unique ids, locked copy, and contract source branches', () => {
    expect(TEAMMATE_TEMPLATES).toHaveLength(8);
    const ids = TEAMMATE_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(8);
    for (const template of TEAMMATE_TEMPLATES) {
      expect(template.title.length).toBeGreaterThan(0);
      expect(template.description.length).toBeGreaterThan(0);
      expect(template.emoji.length).toBeGreaterThan(0);
      // The parallel agor-teammate workstream keys off these exact names.
      expect(template.sourceBranch).toMatch(/^template\//);
      expect(typeof template.icon).toBe('object');
    }
  });

  it('pins the exact source-branch contract names', () => {
    expect(TEAMMATE_TEMPLATES.map((t) => t.sourceBranch)).toEqual([
      'template/competitive-analyst',
      'template/product-manager',
      'template/chief-of-staff',
      'template/financial-analyst',
      'template/deal-desk-revops-analyst',
      'template/sales-outbound-analyst',
      'template/legal-analyst',
      'template/builder',
    ]);
  });

  it('gives each template a distinct emoji (Chief of Staff must not reuse 🧭)', () => {
    const emojis = TEAMMATE_TEMPLATES.map((t) => t.emoji);
    expect(new Set(emojis).size).toBe(emojis.length);
    expect(TEAMMATE_TEMPLATES.find((t) => t.id === 'chief-of-staff')?.emoji).toBe('🗂️');
    expect(TEAMMATE_TEMPLATES.find((t) => t.id === 'product-manager')?.emoji).toBe('🧭');
  });

  it('appends the blank starter to the gallery cards, never to the templates', () => {
    expect(TEAMMATE_GALLERY_CARDS).toHaveLength(9);
    expect(TEAMMATE_GALLERY_CARDS.at(-1)).toBe(BLANK_TEMPLATE);
    expect(BLANK_TEMPLATE.emoji).toBe('');
    expect(BLANK_TEMPLATE.description).toBe(
      'No starter playbook. Tell your teammate what to do and which rules to follow, right in the chat.'
    );
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
  it('All view sorts recommended cards to the front (in rec order), blank last', () => {
    const ids = galleryCardsForFilter(['dig-into-anything'], 'all').map((t) => t.id);
    // dig-into-anything → competitive-analyst, financial-analyst first, blank last.
    expect(ids.slice(0, 2)).toEqual(['competitive-analyst', 'financial-analyst']);
    expect(ids.at(-1)).toBe(BLANK_TEMPLATE_ID);
    // All nine cards present, no dupes.
    expect(ids).toHaveLength(9);
    expect(new Set(ids).size).toBe(9);
  });

  it('All view keeps default order (blank last) when there are no recommendations', () => {
    const ids = galleryCardsForFilter([], 'all').map((t) => t.id);
    expect(ids).toEqual([...TEAMMATE_TEMPLATES.map((t) => t.id), BLANK_TEMPLATE_ID]);
  });

  it('a category filter returns only that category in default order, no blank', () => {
    const ids = galleryCardsForFilter(['dig-into-anything'], 'grow').map((t) => t.id);
    // Recommendations do NOT reorder within a category filter.
    expect(ids).toEqual(['competitive-analyst', 'deal-desk', 'sales-outbound']);
    expect(ids).not.toContain(BLANK_TEMPLATE_ID);
  });
});

describe('getTeammateTemplate', () => {
  it('resolves known ids (including blank) and returns undefined otherwise', () => {
    expect(getTeammateTemplate('legal-analyst')?.title).toBe('Legal Analyst');
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
    // Round-trips with resolveTemplateSourceBranch for every real template.
    for (const template of TEAMMATE_TEMPLATES) {
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

describe('recommendedTemplateIds', () => {
  it('returns [] when no goal is picked', () => {
    expect(recommendedTemplateIds([])).toEqual([]);
  });

  it('returns [] for an unknown goal that maps to no template', () => {
    // Every real goal now maps to a template; only unknown ids resolve to nothing.
    expect(recommendedTemplateIds(['not-a-goal'])).toEqual([]);
  });

  it('recommends Chief of Staff for the personal-teammate goal', () => {
    expect(recommendedTemplateIds(['personal-teammate'])).toEqual(['chief-of-staff']);
  });

  it('recommends Builder for the hand-off-build goal', () => {
    expect(recommendedTemplateIds(['hand-off-build'])).toEqual(['builder']);
  });

  it('returns a single goal’s recommended templates (capped at two)', () => {
    expect(recommendedTemplateIds(['status-updates'])).toEqual(['product-manager']);
    expect(recommendedTemplateIds(['dig-into-anything'])).toEqual([
      'competitive-analyst',
      'financial-analyst',
    ]);
  });

  it('returns both when two goals map to different templates', () => {
    expect(recommendedTemplateIds(['dig-into-anything', 'status-updates'])).toEqual([
      'competitive-analyst',
      'product-manager',
    ]);
  });

  it('dedups when two goals map to the same template', () => {
    expect(recommendedTemplateIds(['status-updates', 'ship-without-busywork'])).toEqual([
      'product-manager',
    ]);
  });

  it('takes each goal’s top rec when two mapping goals are supplied', () => {
    // hand-off-build → builder; dig-into-anything's top rec is competitive-analyst.
    expect(recommendedTemplateIds(['hand-off-build', 'dig-into-anything'])).toEqual([
      'builder',
      'competitive-analyst',
    ]);
  });

  it('ignores unknown goal ids', () => {
    expect(recommendedTemplateIds(['not-a-goal'])).toEqual([]);
    expect(recommendedTemplateIds(['not-a-goal', 'status-updates'])).toEqual(['product-manager']);
  });
});
