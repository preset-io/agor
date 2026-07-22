import { afterEach, describe, expect, it } from 'vitest';
import { buildLaunchInitUrl } from './launchInitUrl';

describe('buildLaunchInitUrl (direct-host entry)', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/ui/');
  });

  it('appends the current host under the configured return-host param', () => {
    window.history.replaceState({}, '', '/ui/s/session-1/');
    const href = buildLaunchInitUrl('https://console.example.test/launch-init', 'return_host');
    const url = new URL(href);
    expect(url.origin).toBe('https://console.example.test');
    expect(url.searchParams.get('return_host')).toBe(window.location.host);
    // deep-link path is preserved as a relative return_to
    expect(url.searchParams.get('return_to')).toBe('/ui/s/session-1/');
  });

  it('omits the host param when none is configured', () => {
    const href = buildLaunchInitUrl('https://console.example.test/launch-init');
    const url = new URL(href);
    expect(url.searchParams.has('return_host')).toBe(false);
    expect(url.searchParams.get('return_to')).toBe('/ui/');
  });

  it('only ever targets the operator-configured launch-init origin', () => {
    const href = buildLaunchInitUrl('https://console.example.test/launch-init', 'return_host');
    expect(new URL(href).origin).toBe('https://console.example.test');
  });

  it('returns the input unchanged when it is not a valid URL', () => {
    expect(buildLaunchInitUrl('not a url', 'return_host')).toBe('not a url');
  });

  it('keeps return_to intact when the host param has a distinct name', () => {
    window.history.replaceState({}, '', '/ui/s/session-1/');
    const href = buildLaunchInitUrl('https://console.example.test/launch-init', 'return_host');
    const url = new URL(href);
    expect(url.searchParams.get('return_to')).toBe('/ui/s/session-1/');
    expect(url.searchParams.get('return_host')).toBe(window.location.host);
  });

  it('demonstrates the hazard that config validation prevents: a return_to host param clobbers the deep-link', () => {
    // If the return-host param were allowed to reuse the reserved `return_to`
    // name, the host set (which runs after return_to) would overwrite the
    // relative deep-link. Core config validation rejects this name for exactly
    // this reason; this test pins the hazard the guard prevents.
    window.history.replaceState({}, '', '/ui/s/session-1/');
    const href = buildLaunchInitUrl('https://console.example.test/launch-init', 'return_to');
    const url = new URL(href);
    expect(url.searchParams.get('return_to')).toBe(window.location.host);
    expect(url.searchParams.get('return_to')).not.toBe('/ui/s/session-1/');
  });
});
