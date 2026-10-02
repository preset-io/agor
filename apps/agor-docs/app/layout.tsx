import { Head } from 'nextra/components';
import 'nextra-theme-docs/style.css';
import { Hanken_Grotesk, JetBrains_Mono, Space_Grotesk } from 'next/font/google';
import Script from 'next/script';
import { type ReactNode, Suspense } from 'react';
import { DocsAuroraBackground } from '../components/DocsAuroraBackground';
import { GoogleAnalytics } from '../components/GoogleAnalytics';
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
        {analyticsEnabled && googleAnalyticsId ? (
          <Suspense fallback={null}>
            <GoogleAnalytics measurementId={googleAnalyticsId} />
          </Suspense>
        ) : null}
        {/* HubSpot tracking / embed loader (portal 246818610). */}
        <Script
          id="hs-script-loader"
          strategy="afterInteractive"
          src="https://js-na2.hs-scripts.com/246818610.js"
        />
        {/* GTM event on contact-form submission. HubSpot's forms-embed
            runtime calls window.postMessage({type:'hsFormCallback', ...})
            unconditionally on every form event — confirmed by reading its
            shipped JS (js.hsforms.net/forms/embed/v2.js): the dispatch isn't
            gated on iframe/cross-origin embedding, so this fires the same
            way whether the form's rendered inline (as ours is, via
            HubSpotForm) or in a HubSpot-hosted iframe. `id` is the form
            GUID; `source_page` (when present in submissionValues) carries
            the per-CTA attribution already stamped by HubSpotForm, so this
            single site-wide listener covers every "Sign up for Agor Cloud"
            entry point without needing one tag per placement. */}
        <Script id="hs-form-submit-tracking" strategy="afterInteractive">
          {`(function () {
            window.addEventListener('message', function (event) {
              var payload = event.data;
              if (
                !payload ||
                payload.type !== 'hsFormCallback' ||
                payload.eventName !== 'onFormSubmitted' ||
                payload.id !== '${HUBSPOT_FORM_ID}'
              ) {
                return;
              }
              var submissionValues = (payload.data && payload.data.submissionValues) || {};
              var sourcePage;
              if (Array.isArray(submissionValues)) {
                var match = submissionValues.filter(function (field) {
                  return field.name === 'source_page';
                })[0];
                sourcePage = match && match.value;
              } else {
                sourcePage = submissionValues.source_page;
              }
              window.dataLayer = window.dataLayer || [];
              window.dataLayer.push({
                event: 'hubspot_interest_form_success',
                form_name: 'agor_cloud_beta',
                source_page: sourcePage || 'unknown',
              });
            });
          })();`}
        </Script>
        {/* GTM events for the "Book a demo" HubSpot meeting scheduler.
            Unlike the contact form, this is a genuinely cross-origin iframe
            (meetings-na2.hubspot.com), so its postMessage contract is much
            narrower — confirmed by reading its shipped JS bundle
            (MeetingsPublic .../bundles/project.js): it only ever posts a
            consent-readiness handshake, an iframe-resize notice, and a
            final `{meetingBookSucceeded}`/`{meetingBookFailed}` on booking
            completion. There's no "opened" or "in progress" signal — the
            scheduler never tells the embedder someone's picking a date.
            "Opened" is tracked separately, client-side, in MeetingEmbed
            (HubSpotMeetingModal.tsx), since we already know that moment
            ourselves without needing HubSpot's cooperation. Origin-checked
            here (unlike the form listener above) because this really is a
            different origin posting to us, not our own same-window script. */}
        <Script id="hs-meeting-book-tracking" strategy="afterInteractive">
          {`(function () {
            window.addEventListener('message', function (event) {
              if (event.origin !== '${hubspotMeetingOrigin}') {
                return;
              }
              var payload = event.data;
              if (!payload || typeof payload !== 'object') {
                return;
              }
              window.dataLayer = window.dataLayer || [];
              if (payload.meetingBookSucceeded) {
                window.dataLayer.push({
                  event: 'hubspot_meeting_booked',
                  form_name: 'agor_cloud_demo',
                });
              } else if (payload.meetingBookFailed) {
                window.dataLayer.push({ event: 'hubspot_meeting_book_failed' });
              }
            });
          })();`}
        </Script>
        {/* Microsoft Clarity analytics (project xroxavynkf). */}
        <Script id="ms-clarity" strategy="afterInteractive">
          {`(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","xroxavynkf");`}
        </Script>
      </body>
    </html>
  );
}
