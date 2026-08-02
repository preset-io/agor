export default {
  index: {
    title: 'Home',
    type: 'page',
    display: 'hidden', // Hide from sidebar
    theme: {
      layout: 'full', // Full page layout without sidebars/navbar
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
