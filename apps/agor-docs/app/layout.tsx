import { Head } from 'nextra/components';
import 'nextra-theme-docs/style.css';
import { Hanken_Grotesk, JetBrains_Mono, Space_Grotesk } from 'next/font/google';
import type { ReactNode } from 'react';
import { DocsAuroraBackground } from '../components/DocsAuroraBackground';
import { GITHUB_REPO_URL } from '../lib/links';
import {
  BRAND_NAME,
  DEFAULT_DESCRIPTION,
  FAVICON_PATH,
  getBasePath,
  getSiteUrl,
  LOGO_MARK_PATH,
  THEME_COLOR,
} from '../lib/siteMetadata';
import './styles.css';

const basePath = getBasePath();
const siteUrl = getSiteUrl();

// Marketing type system (see LandingPage.module.css): Space Grotesk for
// display, Hanken Grotesk for body copy, JetBrains Mono for eyebrows/labels.
// Loaded here so the variables exist site-wide; docs pages keep the Nextra
// default stack until a rule opts in.
const displayFont = Space_Grotesk({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-display',
  display: 'swap',
});
const bodyFont = Hanken_Grotesk({
  subsets: ['latin'],
  weight: ['100', '400', '500', '600', '700'],
  variable: '--font-body',
  display: 'swap',
});
const monoFont = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono-label',
  display: 'swap',
});

export const metadata = {
  applicationName: BRAND_NAME,
  generator: 'Next.js',
  keywords: [
    'team command center',
    'agentic',
    'AI agents',
    'agent orchestration',
    'multiplayer',
    'spatial canvas',
    'Claude Code',
    'Codex',
    'Gemini',
    'git branches',
    'MCP',
    'persistent AI teammates',
    'AI workflow',
    'developer tools',
  ],
  authors: [{ name: 'Preset Inc.' }],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      dir="ltr"
      suppressHydrationWarning
      className={`${displayFont.variable} ${bodyFont.variable} ${monoFont.variable}`}
    >
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="description" content={DEFAULT_DESCRIPTION} />
        <meta name="theme-color" content={THEME_COLOR} />
        <link rel="icon" type="image/svg+xml" href={`${basePath}${LOGO_MARK_PATH}`} />
        {/* PNG fallback for browsers without SVG favicon support */}
        <link rel="alternate icon" type="image/png" href={`${basePath}${FAVICON_PATH}`} />
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is static and controlled, not user-provided.
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'SoftwareApplication',
              name: 'agor',
              description: DEFAULT_DESCRIPTION,
              applicationCategory: 'DeveloperApplication',
              operatingSystem: 'macOS, Linux, Windows',
              offers: {
                '@type': 'Offer',
                price: '0',
                priceCurrency: 'USD',
              },
              url: siteUrl,
              codeRepository: GITHUB_REPO_URL,
              author: {
                '@type': 'Organization',
                name: 'Preset Inc.',
              },
            }),
          }}
        />
      </Head>
      <body>
        <DocsAuroraBackground />
        {children}
      </body>
    </html>
  );
}
