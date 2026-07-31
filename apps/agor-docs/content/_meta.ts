// Homepage hero A/B test variants (see components/heroVariants.tsx) — same
// full-bleed, no-sidebar treatment as `index`, hidden from nav since these
// are campaign landing pages, not docs to browse.
const heroVariantMeta = {
  type: 'page' as const,
  display: 'hidden' as const,
  theme: {
    layout: 'full' as const,
  },
};

export default {
  index: {
    title: 'Home',
    type: 'page',
    display: 'hidden', // Hide from sidebar
    theme: {
      layout: 'full', // Full page layout without sidebars/navbar
    },
  },
  'build-together': heroVariantMeta,
  'company-wide-ai': heroVariantMeta,
  'every-team': heroVariantMeta,
  'open-source': heroVariantMeta,
  'hand-off-the-work': heroVariantMeta,
  // Navbar links are separate from the content folders so Docs and Blog can
  // also remain in the shared root sidebar on every content surface.
  'docs-navbar': { title: 'Docs', type: 'page', href: '/guide' },
  'blog-navbar': { title: 'Blog', type: 'page', href: '/blog' },
  guide: 'Docs',
  blog: 'Blog',
  'api-reference': 'API Reference',
  security: 'Security',
  faq: 'FAQ',
};
