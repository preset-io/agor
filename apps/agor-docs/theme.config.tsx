import { useRouter } from 'next/router';
import type { DocsThemeConfig } from 'nextra-theme-docs';
import { useConfig } from 'nextra-theme-docs';

const config: DocsThemeConfig = {
  logo: (
    <span style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo.png"
        alt="Agor"
        style={{ height: '42px', width: '42px' }}
        suppressHydrationWarning
      />
      <strong style={{ fontSize: '18px' }}>Agor</strong>
      <span
        style={{
          fontSize: '11px',
          padding: '2px 6px',
          background: '#2e9a92',
          color: 'white',
          borderRadius: '4px',
          fontWeight: 600,
        }}
      >
        BETA
      </span>
    </span>
  ),
  project: {
    link: 'https://github.com/mistercrunch/agor',
  },
  docsRepositoryBase: 'https://github.com/mistercrunch/agor/tree/main/apps/agor-docs',

  useNextSeoProps() {
    const { asPath } = useRouter();
    if (asPath !== '/') {
      return {
        titleTemplate: '%s – Agor',
      };
    }
    return {
      titleTemplate: 'Agor – Next-gen agent orchestration',
    };
  },

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
    const pageTitle = title || frontMatter.title || 'Agor';

    return (
      <>
        <title>
          {pageTitle === 'Agor' ? 'Agor – Next-gen agent orchestration' : `${pageTitle} – Agor`}
        </title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta property="og:title" content={pageTitle} />
        <meta
          property="og:description"
          content={
            frontMatter.description || 'Next-gen agent orchestration for AI-assisted development'
          }
        />
        <meta name="theme-color" content="#2e9a92" />
        <link rel="icon" type="image/png" href="/favicon.png" />
      </>
    );
  },

  primaryHue: 174, // Teal hue for #2e9a92
  primarySaturation: 55,

  darkMode: true,
  nextThemes: {
    defaultTheme: 'dark',
  },
};

export default config;
