import { describe, expect, it } from 'vitest';
import {
  BLANK_TEMPLATE,
  BLANK_TEMPLATE_ID,
  getTeammateTemplate,
  recommendedTemplateIds,
  resolveTemplateSourceBranch,
  TEAMMATE_GALLERY_CARDS,
  TEAMMATE_TEMPLATES,
} from './teammateTemplates';

describe('TEAMMATE_TEMPLATES', () => {
  it('defines the seven templates with unique ids, locked copy, and contract source branches', () => {
    expect(TEAMMATE_TEMPLATES).toHaveLength(7);
    const ids = TEAMMATE_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(7);
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
    ]);
  });

  it('gives each template a distinct emoji (Chief of Staff must not reuse 🧭)', () => {
    const emojis = TEAMMATE_TEMPLATES.map((t) => t.emoji);
    expect(new Set(emojis).size).toBe(emojis.length);
    expect(TEAMMATE_TEMPLATES.find((t) => t.id === 'chief-of-staff')?.emoji).toBe('🗂️');
    expect(TEAMMATE_TEMPLATES.find((t) => t.id === 'product-manager')?.emoji).toBe('🧭');
  });

  it('appends the blank starter to the gallery cards, never to the templates', () => {
    expect(TEAMMATE_GALLERY_CARDS).toHaveLength(8);
    expect(TEAMMATE_GALLERY_CARDS.at(-1)).toBe(BLANK_TEMPLATE);
    expect(BLANK_TEMPLATE.emoji).toBe('');
    expect(TEAMMATE_TEMPLATES).not.toContain(BLANK_TEMPLATE);
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
  it('forces a real template branch and defers blank/none to the repo default', () => {
    expect(resolveTemplateSourceBranch('deal-desk')).toBe('template/deal-desk-revops-analyst');
    expect(resolveTemplateSourceBranch(BLANK_TEMPLATE_ID)).toBeUndefined();
    expect(resolveTemplateSourceBranch(null)).toBeUndefined();
    expect(resolveTemplateSourceBranch('nope')).toBeUndefined();
  });
});

describe('recommendedTemplateIds', () => {
  it('returns [] when no goal is picked', () => {
    expect(recommendedTemplateIds([])).toEqual([]);
  });

  it('returns [] for a goal that maps to no template', () => {
    // hand-off-build is now the only goal with no template (builder is a future add).
    expect(recommendedTemplateIds(['hand-off-build'])).toEqual([]);
  });

  it('recommends Chief of Staff for the personal-teammate goal', () => {
    expect(recommendedTemplateIds(['personal-teammate'])).toEqual(['chief-of-staff']);
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

  it('keeps just the match when one goal maps to nothing and the other maps', () => {
    // hand-off-build maps to nothing; dig-into-anything's top rec survives.
    expect(recommendedTemplateIds(['hand-off-build', 'dig-into-anything'])).toEqual([
      'competitive-analyst',
    ]);
  });

  it('ignores unknown goal ids', () => {
    expect(recommendedTemplateIds(['not-a-goal'])).toEqual([]);
    expect(recommendedTemplateIds(['not-a-goal', 'status-updates'])).toEqual(['product-manager']);
  });
});
