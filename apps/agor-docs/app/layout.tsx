import { Head } from 'nextra/components';
import 'nextra-theme-docs/style.css';
import { Hanken_Grotesk, JetBrains_Mono, Space_Grotesk } from 'next/font/google';
import Script from 'next/script';
import { type ReactNode, Suspense } from 'react';
import { CookieConsent } from '../components/CookieConsent';
import { DocsAuroraBackground } from '../components/DocsAuroraBackground';
import { GoogleAnalytics } from '../components/GoogleAnalytics';
import { consentBootScript } from '../lib/consent';
import { crtIntroBootScript } from '../lib/crtIntro';
import { hubspotFormTrackingScript, hubspotMeetingTrackingScript } from '../lib/hubspotTracking';
import {
  AGOR_CLOUD_DEMO_URL,
  DISCORD_INVITE_URL,
  GITHUB_REPO_URL,
  HUBSPOT_FORM_ID,
} from '../lib/links';
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
const hubspotMeetingOrigin = new URL(AGOR_CLOUD_DEMO_URL).origin;
const googleAnalyticsId = process.env.NEXT_PUBLIC_GA_ID;
const analyticsEnabled =
  Boolean(googleAnalyticsId) &&
  (process.env.NODE_ENV === 'production' || process.env.NEXT_PUBLIC_ANALYTICS_DEBUG === 'true');

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
  // 300 is used (hero subhead, detail titles); without it the browser fell
  // back to 100.
  weight: ['100', '300', '400', '500', '600', '700'],
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
        {/* Cookie consent: sets Google's Consent Mode default, then loads Tag
            Manager (GTM-WL3Q29NW) only if consent allows. No <noscript>
            fallback: without JavaScript there's no way to ask. See
            lib/consent.ts. */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static, build-time script; no user input.
          dangerouslySetInnerHTML={{ __html: consentBootScript() }}
        />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        {/* Before first paint: the optional CRT intro (?intro=true) covers the
            home page, so it never flashes the site first. See lib/crtIntro. */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static, build-time script; no user input.
          dangerouslySetInnerHTML={{ __html: crtIntroBootScript(basePath) }}
        />
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
        <DocsAuroraBackground />
        {children}
        {analyticsEnabled && googleAnalyticsId ? (
          <Suspense fallback={null}>
            <GoogleAnalytics measurementId={googleAnalyticsId} />
          </Suspense>
        ) : null}
        {/* The cookie banner. It also loads HubSpot's tracking code (portal
            246818610) and Microsoft Clarity, only once consent allows. */}
        <CookieConsent />
        {/* GA4 + GTM events on sign-up form submission, for every "Sign up
            for Agor Cloud" entry point (see lib/hubspotTracking.ts). */}
        <Script id="hs-form-submit-tracking" strategy="afterInteractive">
          {hubspotFormTrackingScript(HUBSPOT_FORM_ID)}
        </Script>
        {/* GA4 + GTM events when a demo is booked in the HubSpot scheduler
            (lib/hubspotTracking.ts). MeetingEmbed reports the open. */}
        <Script id="hs-meeting-book-tracking" strategy="afterInteractive">
          {hubspotMeetingTrackingScript(hubspotMeetingOrigin)}
        </Script>
      </body>
    </html>
  );
}
