import { ADS_CONVERSIONS, adsConversionSnippet } from './consent';

/**
 * Inline listeners for the HubSpot sign-up form and the "Book a demo"
 * scheduler (rendered by app/layout.tsx). Each outcome goes to two places:
 *
 * - GA4, directly through gtag, so it works without Tag Manager (which loads
 *   only with marketing consent) and lands in the same property as
 *   console.agor.cloud's events. `generate_lead` matches the console's waitlist
 *   event; `form_name` tells the forms apart.
 * - Tag Manager's dataLayer, unchanged, for its Google Ads conversion triggers.
 *   The container has no GA4 tags, so nothing is counted twice.
 *
 * Parameters never carry what the visitor typed: only the form name and the
 * CTA tag (`source_page`).
 */

/** GA4 event for a submitted Agor Cloud sign-up form. */
export const FORM_SUBMIT_EVENT = 'generate_lead';
/** GA4 event for a booked demo. */
export const DEMO_BOOKED_EVENT = 'demo_booked';

/**
 * HubSpot's forms-embed runtime posts `{type: 'hsFormCallback', ...}` to the
 * window on every form event, inline or iframed (confirmed in
 * js.hsforms.net/forms/embed/v2.js). Same window, so no origin check.
 */
export function hubspotFormTrackingScript(formId: string): string {
  return `(function () {
  window.addEventListener('message', function (event) {
    var payload = event.data;
    if (
      !payload ||
      payload.type !== 'hsFormCallback' ||
      payload.eventName !== 'onFormSubmitted' ||
      payload.id !== ${JSON.stringify(formId)}
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
    var params = { form_name: 'agor_cloud_beta', source_page: sourcePage || 'unknown' };
    if (window.gtag) window.gtag('event', ${JSON.stringify(FORM_SUBMIT_EVENT)}, params);
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({
      event: 'hubspot_interest_form_success',
      form_name: params.form_name,
      source_page: params.source_page,
    });
    ${adsConversionSnippet(ADS_CONVERSIONS.signup)}
  });
})();`;
}

/**
 * The scheduler is a cross-origin iframe that posts only a consent handshake,
 * a resize notice and a final `{meetingBookSucceeded}` / `{meetingBookFailed}`
 * (confirmed in its shipped bundle), so only the booking outcome is reported
 * here; MeetingEmbed reports the open. Origin-checked: another site posts it.
 */
export function hubspotMeetingTrackingScript(meetingOrigin: string): string {
  return `(function () {
  window.addEventListener('message', function (event) {
    if (event.origin !== ${JSON.stringify(meetingOrigin)}) {
      return;
    }
    var payload = event.data;
    if (!payload || typeof payload !== 'object') {
      return;
    }
    window.dataLayer = window.dataLayer || [];
    if (payload.meetingBookSucceeded) {
      if (window.gtag)
        window.gtag('event', ${JSON.stringify(DEMO_BOOKED_EVENT)}, { form_name: 'agor_cloud_demo' });
      window.dataLayer.push({
        event: 'hubspot_meeting_booked',
        form_name: 'agor_cloud_demo',
      });
      ${adsConversionSnippet(ADS_CONVERSIONS.demo)}
    } else if (payload.meetingBookFailed) {
      window.dataLayer.push({ event: 'hubspot_meeting_book_failed' });
    }
  });
})();`;
}
