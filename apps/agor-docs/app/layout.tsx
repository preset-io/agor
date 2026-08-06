import { Head } from 'nextra/components';
import 'nextra-theme-docs/style.css';
import { Hanken_Grotesk, JetBrains_Mono, Space_Grotesk } from 'next/font/google';
import Script from 'next/script';
import type { ReactNode } from 'react';
import { DocsAuroraBackground } from '../components/DocsAuroraBackground';
import { DISCORD_INVITE_URL, GITHUB_REPO_URL } from '../lib/links';
import {
  BRAND_NAME,
  DEFAULT_DESCRIPTION,
  getBasePath,
  getSiteUrl,
  LOGO_PATH,
  THEME_COLOR,
  toAbsoluteUrl,
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
        {/* Google Tag Manager (container GTM-WL3Q29NW). Loaded as high in the
            head as possible so downstream tags fire early. */}
        <Script id="gtm-loader" strategy="afterInteractive">
          {`(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-WL3Q29NW');`}
        </Script>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="description" content={DEFAULT_DESCRIPTION} />
        <meta name="theme-color" content={THEME_COLOR} />
        <link rel="icon" type="image/svg+xml" href={`${basePath}${LOGO_PATH}`} />
        <link rel="apple-touch-icon" sizes="180x180" href={`${basePath}/apple-touch-icon.png`} />
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is static and controlled, not user-provided.
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@graph': [
                {
                  '@type': 'Organization',
                  '@id': `${siteUrl}/#organization`,
                  name: 'Preset Inc.',
                  url: 'https://preset.io',
                  logo: toAbsoluteUrl('/preset-logo.svg'),
                  sameAs: [GITHUB_REPO_URL, DISCORD_INVITE_URL],
                },
                {
                  '@type': 'WebSite',
                  '@id': `${siteUrl}/#website`,
                  name: BRAND_NAME,
                  url: siteUrl,
                  publisher: { '@id': `${siteUrl}/#organization` },
                },
                {
                  '@type': 'SoftwareApplication',
                  '@id': `${siteUrl}/#software`,
                  name: 'Agor',
                  description: DEFAULT_DESCRIPTION,
                  applicationCategory: 'DeveloperApplication',
                  operatingSystem: 'macOS, Linux, Windows',
                  // Source-available BSL 1.1 build permits self-hosted production use.
                  offers: {
                    '@type': 'Offer',
                    price: '0',
                    priceCurrency: 'USD',
                  },
                  url: siteUrl,
                  screenshot: toAbsoluteUrl('/screenshots/board-hero.png'),
                  softwareHelp: toAbsoluteUrl('/guide'),
                  codeRepository: GITHUB_REPO_URL,
                  author: { '@id': `${siteUrl}/#organization` },
                },
              ],
            }),
          }}
        />
      </Head>
      <body>
        {/* Google Tag Manager (noscript) — must sit immediately after the
            opening body tag. */}
        <noscript>
          <iframe
            title="Google Tag Manager"
            src="https://www.googletagmanager.com/ns.html?id=GTM-WL3Q29NW"
            height="0"
            width="0"
            style={{ display: 'none', visibility: 'hidden' }}
          />
        </noscript>
        <DocsAuroraBackground />
        {children}
        {/* HubSpot tracking / embed loader (portal 246818610). */}
        <Script
          id="hs-script-loader"
          strategy="afterInteractive"
          src="https://js-na2.hs-scripts.com/246818610.js"
        />
        {/* Microsoft Clarity analytics (project xroxavynkf). */}
        <Script id="ms-clarity" strategy="afterInteractive">
          {`(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","xroxavynkf");`}
        </Script>
      </body>
    </html>
  );
}
