// Marketing landing pages (hub-and-spoke off the homepage; see
// components/landing/pages.ts): full-bleed, hidden from the sidebar.
const landingPageMeta = {
  type: 'page' as const,
  display: 'hidden' as const,
  theme: {
    layout: 'full' as const,
    // The page renders its own footer (LandingShell); the docs footer would stack under it.
    footer: false,
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
  // Agor Cloud marketing landing page. Reached from the island nav's Product
  // menu and palette (components/nav/navData.ts); hidden from the sidebar and rendered full-bleed
  // like the homepage via `theme.layout: 'full'`. The request-invite form
  // stays behind the on-page CTAs.
  cloud: {
    title: 'Agor Cloud',
    type: 'page',
    display: 'hidden',
    theme: {
      layout: 'full',
      // AgorCloudLanding renders its own footer.
      footer: false,
    },
  },
  // Contact / "Talk to us" landing page. A standalone destination that renders
  // the same HubSpot scheduler as "Book a demo" inline; hidden from the sidebar
  // and rendered full-bleed like the homepage via `theme.layout: 'full'`.
  contact: {
    title: 'Contact',
    type: 'page',
    display: 'hidden',
    theme: {
      layout: 'full',
    },
  },
  multiplayer: landingPageMeta,
  board: landingPageMeta,
  teammates: landingPageMeta,
  'command-center': landingPageMeta,
  governance: landingPageMeta,
  // The Preset agent roster (linked from the home radar and the nav); not a
  // spoke in LANDING_PAGES, but framed the same way.
  'agent-roster': landingPageMeta,
  guide: 'Docs',
  blog: 'Blog',
  'api-reference': 'API Reference',
  security: 'Security',
  faq: 'FAQ',
  // Linked from every footer; hidden from the sidebar.
  privacy: { title: 'Privacy Policy', display: 'hidden' },
  terms: { title: 'Terms of Use', display: 'hidden' },
};
