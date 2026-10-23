import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { ADS_CONVERSIONS } from './consent';
import { hubspotFormTrackingScript, hubspotMeetingTrackingScript } from './hubspotTracking';

const FORM_ID = 'form-guid';
const MEETING_ORIGIN = 'https://meetings-na2.hubspot.com';

/** Runs an inline script against a fake window; returns its message dispatcher. */
function run(script: string, { gtm = false }: { gtm?: boolean } = {}) {
  const listeners: Array<(event: { origin: string; data: unknown }) => void> = [];
  const gtag: unknown[][] = [];
  const window = {
    dataLayer: [] as unknown[],
    __agorGtmLoaded: gtm,
    gtag: (...args: unknown[]) => {
      gtag.push(args);
    },
    addEventListener: (_type: string, listener: (typeof listeners)[number]) => {
      listeners.push(listener);
    },
  };
  runInNewContext(script, { window });
  const post = (data: unknown, origin = 'https://agor.live') => {
    for (const listener of listeners) listener({ origin, data });
  };
  // gtag args come from another realm; normalize so toEqual compares plain data.
  const sent = () => JSON.parse(JSON.stringify(gtag)) as unknown[][];
  return { window, post, sent };
}

const submitted = (submissionValues: unknown, id = FORM_ID) => ({
  type: 'hsFormCallback',
  eventName: 'onFormSubmitted',
  id,
  data: { submissionValues },
});

describe('hubspotFormTrackingScript', () => {
  it('sends generate_lead to GA4 and keeps the GTM event and Ads conversion', () => {
    const { window, post, sent } = run(hubspotFormTrackingScript(FORM_ID));
    post(submitted({ email: 'ada@example.com', source_page: 'home-hero' }));
    expect(sent()).toEqual([
      ['event', 'generate_lead', { form_name: 'agor_cloud_beta', source_page: 'home-hero' }],
      ['event', 'conversion', { send_to: ADS_CONVERSIONS.signup }],
    ]);
    expect(window.dataLayer).toEqual([
      {
        event: 'hubspot_interest_form_success',
        form_name: 'agor_cloud_beta',
        source_page: 'home-hero',
      },
    ]);
    // Never what the visitor typed.
    expect(JSON.stringify([sent(), window.dataLayer])).not.toContain('ada@example.com');
  });

  it('reads source_page from the array form and defaults it', () => {
    const { post, sent } = run(hubspotFormTrackingScript(FORM_ID), { gtm: true });
    post(submitted([{ name: 'source_page', value: 'pricing' }]));
    post(submitted({}));
    expect(sent()).toEqual([
      ['event', 'generate_lead', { form_name: 'agor_cloud_beta', source_page: 'pricing' }],
      ['event', 'generate_lead', { form_name: 'agor_cloud_beta', source_page: 'unknown' }],
    ]);
  });

  it('ignores other forms and other form events', () => {
    const { window, post, sent } = run(hubspotFormTrackingScript(FORM_ID));
    post(submitted({}, 'other-form'));
    post({ ...submitted({}), eventName: 'onFormReady' });
    post('not an object');
    expect(sent()).toEqual([]);
    expect(window.dataLayer).toEqual([]);
  });
});

describe('hubspotMeetingTrackingScript', () => {
  it('sends demo_booked to GA4 only for a booking from the scheduler origin', () => {
    const { window, post, sent } = run(hubspotMeetingTrackingScript(MEETING_ORIGIN), {
      gtm: true,
    });
    post({ meetingBookSucceeded: true }, 'https://evil.example');
    expect(sent()).toEqual([]);
    post({ meetingBookSucceeded: true }, MEETING_ORIGIN);
    expect(sent()).toEqual([['event', 'demo_booked', { form_name: 'agor_cloud_demo' }]]);
    expect(window.dataLayer).toEqual([
      { event: 'hubspot_meeting_booked', form_name: 'agor_cloud_demo' },
    ]);
  });

  it('reports a failed booking to GTM only', () => {
    const { window, post, sent } = run(hubspotMeetingTrackingScript(MEETING_ORIGIN));
    post({ meetingBookFailed: true }, MEETING_ORIGIN);
    expect(sent()).toEqual([]);
    expect(window.dataLayer).toEqual([{ event: 'hubspot_meeting_book_failed' }]);
  });
});
