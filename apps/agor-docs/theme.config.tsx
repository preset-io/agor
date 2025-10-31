import type { DocsThemeConfig } from 'nextra-theme-docs';
import { useConfig } from 'nextra-theme-docs';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

const config: DocsThemeConfig = {
  logo: (
    <span style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {/* biome-ignore lint/performance/noImgElement: Using img for static assets in docs */}
      <img
        src={`${basePath}/logo.png`}
        alt="agor"
        style={{ height: '42px', width: '42px', borderRadius: '50%' }}
        suppressHydrationWarning
      />
      <strong style={{ fontSize: '18px' }}>agor</strong>
    </span>
  ),
  project: {
    link: 'https://github.com/preset-io/agor',
  },
  docsRepositoryBase: 'https://github.com/preset-io/agor/tree/main/apps/agor-docs',

  navigation: {
    prev: true,
    next: true,
  },

  sidebar: {
    defaultMenuCollapseLevel: 1,
    toggleButton: true,
  },

  footer: {
    component: <span>BSL 1.1 © {new Date().getFullYear()} Maxime Beauchemin</span>,
  },

  toc: {
    backToTop: true,
  },

  editLink: {
    component: () => <>Edit this page on GitHub →</>,
  },

  feedback: {
    content: 'Question? Give us feedback →',
    labels: 'feedback',
  },

  search: {
    placeholder: 'Search documentation...',
  },

  head: () => {
    const { frontMatter, title } = useConfig();
    const pageTitle = title || frontMatter.title || 'agor';
    const description =
      frontMatter.description ||
      'Next-gen agent orchestration for AI coding. Multiplayer workspace for Claude Code, Codex, and Gemini.';
    const fullTitle =
      pageTitle === 'agor' ? 'agor – Next-gen agent orchestration' : `${pageTitle} – agor`;
    const ogImage = 'https://agor.live/hero.png';
    const siteUrl = 'https://agor.live';

    return (
      <>
        <title>{fullTitle}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />

        {/* Standard Meta Tags */}
        <meta name="description" content={description} />
        <meta
          name="keywords"
          content="AI coding, agent orchestration, Claude Code, Codex, Gemini, AI development, multiplayer IDE, git worktrees, agentic coding, AI agents, developer tools"
        />
        <meta name="author" content="Maxime Beauchemin" />

        {/* Open Graph */}
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="agor" />
        <meta property="og:title" content={fullTitle} />
        <meta property="og:description" content={description} />
        <meta property="og:image" content={ogImage} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:url" content={siteUrl} />

        {/* Twitter Card */}
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={fullTitle} />
        <meta name="twitter:description" content={description} />
        <meta name="twitter:image" content={ogImage} />

        {/* Additional Meta */}
        <meta name="theme-color" content="#2e9a92" />
        <link rel="icon" type="image/png" href={`${basePath}/favicon.png`} />
        <link rel="canonical" href={siteUrl} />

        {/* JSON-LD Structured Data */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'SoftwareApplication',
              name: 'agor',
              description:
                'Next-gen agent orchestration for AI coding. Multiplayer workspace for Claude Code, Codex, and Gemini.',
              applicationCategory: 'DeveloperApplication',
              operatingSystem: 'macOS, Linux, Windows',
              offers: {
                '@type': 'Offer',
                price: '0',
                priceCurrency: 'USD',
              },
              url: 'https://agor.live',
              codeRepository: 'https://github.com/mistercrunch/agor',
              author: {
                '@type': 'Person',
                name: 'Maxime Beauchemin',
              },
              screenshot: 'https://agor.live/hero.png',
            }),
          }}
        />
      </>
    );
  },

  color: {
    hue: 174, // Teal hue for #2e9a92
    saturation: 55,
  },

  nextThemes: {
    defaultTheme: 'dark',
    forcedTheme: 'dark', // Force dark mode
  },
};

export default config;
