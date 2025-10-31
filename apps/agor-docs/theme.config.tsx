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

    return (
      <>
        <title>
          {pageTitle === 'agor' ? 'agor – Next-gen agent orchestration' : `${pageTitle} – agor`}
        </title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta property="og:title" content={pageTitle} />
        <meta
          property="og:description"
          content={frontMatter.description || 'Next-gen agent orchestration for AI coding'}
        />
        <meta name="theme-color" content="#2e9a92" />
        <link rel="icon" type="image/png" href={`${basePath}/favicon.png`} />
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
