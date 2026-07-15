export default {
  index: {
    title: 'Home',
    type: 'page',
    display: 'hidden', // Hide from sidebar
    theme: {
      layout: 'full', // Full page layout without sidebars/navbar
    },
  },
  // type: 'page' lifts these into the top navbar (left of search); they
  // also remain reachable from the mobile menu.
  guide: { title: 'Docs', type: 'page' },
  blog: { title: 'Blog', type: 'page' },
  'api-reference': 'API Reference',
  security: 'Security',
  faq: 'FAQ',
};
