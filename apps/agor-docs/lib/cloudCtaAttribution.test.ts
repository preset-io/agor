import { afterEach, describe, expect, it, vi } from 'vitest';
import { onCloudCtaClick, withCtaAttribution } from './cloudCtaAttribution';

const TOKEN = '0123456789abcdef0123456789abcdef';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('withCtaAttribution', () => {
  it('tags console links with UTM and source, leaving other links alone', () => {
    const tagged = new URL(withCtaAttribution('https://console.agor.cloud/', 'blog-open-beta-top'));
    expect(Object.fromEntries(tagged.searchParams)).toEqual({
      utm_source: 'agor.live',
      utm_medium: 'referral',
      utm_campaign: 'agor-cloud-cta',
      utm_content: 'blog-open-beta-top',
      source: 'blog-open-beta-top',
    });
    expect(withCtaAttribution('#cloud-signup-form', 'x')).toBe('#cloud-signup-form');
    expect(withCtaAttribution('https://agor.live/guide', 'x')).toBe('https://agor.live/guide');
  });
});

describe('onCloudCtaClick', () => {
  function stubBrowser(cookie: string, search = '') {
    const dataLayer: unknown[] = [];
    vi.stubGlobal('window', { dataLayer, location: { search } });
    vi.stubGlobal('document', { cookie });
    return dataLayer;
  }

  it('reports the click and hands the HubSpot visitor token to console links', () => {
    const dataLayer = stubBrowser(`a=1; hubspotutk=${TOKEN}`);
    const anchor = { href: 'https://console.agor.cloud/?source=hero' } as HTMLAnchorElement;
    onCloudCtaClick('hero', 'console', anchor);
    expect(dataLayer).toEqual([
      { event: 'agor_cloud_cta_click', source_page: 'hero', cloud_cta_variant: 'console' },
    ]);
    expect(new URL(anchor.href).searchParams.get('hutk')).toBe(TOKEN);
  });

  it('leaves links untouched without a valid token or off the console', () => {
    stubBrowser('hubspotutk=bad');
    const consoleLink = { href: 'https://console.agor.cloud/' } as HTMLAnchorElement;
    onCloudCtaClick('hero', 'console', consoleLink);
    expect(consoleLink.href).toBe('https://console.agor.cloud/');

    stubBrowser(`hubspotutk=${TOKEN}`);
    const other = { href: 'https://agor.live/' } as HTMLAnchorElement;
    onCloudCtaClick('hero', 'console', other);
    expect(other.href).toBe('https://agor.live/');
  });

  it('forwards a Google Ads click id from the current page to console links', () => {
    stubBrowser('', '?gclid=abc123');
    const anchor = { href: 'https://console.agor.cloud/' } as HTMLAnchorElement;
    onCloudCtaClick('hero', 'console', anchor);
    expect(new URL(anchor.href).searchParams.get('gclid')).toBe('abc123');
  });

  it('forwards gbraid/wbraid alongside the visitor token when both are present', () => {
    stubBrowser(`hubspotutk=${TOKEN}`, '?gbraid=xyz&wbraid=789');
    const anchor = { href: 'https://console.agor.cloud/' } as HTMLAnchorElement;
    onCloudCtaClick('hero', 'console', anchor);
    const params = new URL(anchor.href).searchParams;
    expect(params.get('hutk')).toBe(TOKEN);
    expect(params.get('gbraid')).toBe('xyz');
    expect(params.get('wbraid')).toBe('789');
  });
});
