import type {} from '@vitest/browser-playwright';
import { afterEach, beforeAll, beforeEach, expect } from 'vitest';
import { cdp } from 'vitest/browser';

/** Inspect actual Chromium runtime/network events, including lazy UI module requests. */
export function checkBrowserSanity() {
  const session = cdp();
  let failures: string[] = [];
  const failedRequest = (event: { errorText: string; canceled?: boolean }) => {
    if (!event.canceled) failures.push(`Request failed: ${event.errorText}`);
  };
  const response = (event: { response: { status: number; url: string } }) => {
    if (event.response.status >= 400) {
      failures.push(`HTTP ${event.response.status}: ${event.response.url}`);
    }
  };
  const exception = (event: { exceptionDetails: { text: string } }) => {
    failures.push(`Uncaught exception: ${event.exceptionDetails.text}`);
  };
  beforeAll(() => {
    session.on('Network.loadingFailed', failedRequest);
    session.on('Network.responseReceived', response);
    session.on('Runtime.exceptionThrown', exception);
  });
  beforeEach(async () => {
    failures = [];
    await session.send('Network.enable');
    await session.send('Runtime.enable');
  });
  afterEach(async () => {
    await session.send('Network.disable');
    expect(failures, 'Chromium console/network sanity').toEqual([]);
  });
}
