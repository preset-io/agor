export default {
  index: {
    title: 'Home',
    type: 'page',
    display: 'hidden', // Hide from sidebar
    theme: {
      layout: 'raw', // Full page layout without sidebars/navbar
    },
  },
  guide: 'Guide',
  'api-reference': 'API Reference',
  blog: {
    title: 'Blog',
    type: 'page',
    theme: {
      sidebar: false,
      toc: false,
    },
  },
  security: 'Security',
  faq: 'FAQ',
};
