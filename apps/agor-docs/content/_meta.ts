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
  'not-alone': heroVariantMeta,
  'not-alone-problem': heroVariantMeta,
  'beyond-the-sandbox': heroVariantMeta,
  'not-just-a-tool': heroVariantMeta,
  'right-where-you-work': heroVariantMeta,
  'team-sport': heroVariantMeta,
  'selfware-is-dead': heroVariantMeta,
  'dev-team': heroVariantMeta,
  'costs-under-control': heroVariantMeta,
  'costs-under-control-solution': heroVariantMeta,
  // Agor Cloud marketing landing page. Reached via the navbar "Agor Cloud"
  // link (see NavbarCloudCTA); hidden from the sidebar and rendered full-bleed
  // like the homepage via `theme.layout: 'full'`. The request-invite form
  // stays behind the on-page CTAs.
  cloud: {
    title: 'Agor Cloud',
    type: 'page',
    display: 'hidden',
    theme: {
      layout: 'full',
    },
  },
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
