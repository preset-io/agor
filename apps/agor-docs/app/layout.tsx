import { Head } from 'nextra/components';
import 'nextra-theme-docs/style.css';
import type { ReactNode } from 'react';
import { DocsBackground } from '../components/DocsBackground';
import { GITHUB_REPO_URL } from '../lib/links';
import {
  BRAND_NAME,
  DEFAULT_DESCRIPTION,
  FAVICON_PATH,
  getBasePath,
  getSiteUrl,
  THEME_COLOR,
} from '../lib/siteMetadata';
import './styles.css';

const basePath = getBasePath();
const siteUrl = getSiteUrl();

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
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="description" content={DEFAULT_DESCRIPTION} />
        <meta name="theme-color" content={THEME_COLOR} />
        <link rel="icon" type="image/png" href={`${basePath}${FAVICON_PATH}`} />
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
        <DocsBackground />
        {children}
      </body>
    </html>
  );
}
