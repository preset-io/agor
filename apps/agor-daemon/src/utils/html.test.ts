import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAUTH_SUCCESS_AUTO_CLOSE_DELAY_MS, renderOAuthResultPage } from './html.js';

function inlineScript(html: string): string {
  const match = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error('Expected an inline OAuth confirmation script');
  return match[1];
}

function confirmationRuntime(opts: { closeAllowed?: boolean } = {}) {
  const elements = {
    'close-countdown': { textContent: '3 seconds' },
    'close-status': {
      textContent: 'This tab will close automatically in 3 seconds.',
    },
  };
  const root = { dataset: {} as Record<string, string> };
  let pagehide: (() => void) | undefined;
  const windowObject = {
    closed: false,
    close: vi.fn(),
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === 'pagehide') pagehide = listener;
    }),
  };
  if (opts.closeAllowed) {
    windowObject.close.mockImplementation(() => {
      windowObject.closed = true;
    });
  }
  const documentObject = {
    documentElement: root,
    getElementById: (id: keyof typeof elements) => elements[id] ?? null,
  };

  return {
    elements,
    pagehide: () => pagehide?.(),
    root,
    run: (script: string) =>
      vm.runInNewContext(script, { document: documentObject, window: windowObject }),
    window: windowObject,
  };
}

describe('renderOAuthResultPage', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows a clear success and accessible three-second close notice immediately', () => {
    const page = renderOAuthResultPage(true, 'OAuth authentication was successful.');

    expect(page.html).toContain('<h1 id="result-heading">Authentication complete</h1>');
    expect(page.html).toContain('OAuth authentication was successful.');
    expect(page.html).toContain('This tab will close automatically in');
    expect(page.html).toContain('role="timer" aria-live="off"');
    expect(page.html).toContain('3 seconds');
    expect(page.html).toContain('If this page stays open, you can close this tab');

    const nonce = page.html.match(/<script nonce="([^"]+)">/)?.[1];
    expect(nonce).toBeTruthy();
    expect(page.contentSecurityPolicy).toContain(`script-src 'nonce-${nonce}'`);
  });

  it('attempts to close only after the full delay and updates the quiet countdown', () => {
    const page = renderOAuthResultPage(true, 'Connected.');
    const runtime = confirmationRuntime({ closeAllowed: true });
    runtime.run(inlineScript(page.html));

    expect(runtime.window.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(runtime.elements['close-countdown'].textContent).toBe('2 seconds');
    vi.advanceTimersByTime(1_000);
    expect(runtime.elements['close-countdown'].textContent).toBe('1 second');
    vi.advanceTimersByTime(OAUTH_SUCCESS_AUTO_CLOSE_DELAY_MS - 2_000 - 1);
    expect(runtime.window.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(runtime.window.close).toHaveBeenCalledOnce();
  });

  it('keeps a useful manual-tab fallback when the browser blocks close', () => {
    const page = renderOAuthResultPage(true, 'Connected.');
    const runtime = confirmationRuntime();
    runtime.run(inlineScript(page.html));

    vi.advanceTimersByTime(OAUTH_SUCCESS_AUTO_CLOSE_DELAY_MS);

    expect(runtime.window.close).toHaveBeenCalledOnce();
    expect(runtime.window.closed).toBe(false);
    expect(runtime.elements['close-status'].textContent).toBe(
      'This tab did not close automatically. You can close this tab and return to Agor.'
    );
  });

  it('does not depend on an opener for direct navigation', () => {
    const page = renderOAuthResultPage(true, 'Connected.');
    const runtime = confirmationRuntime();

    expect(() => runtime.run(inlineScript(page.html))).not.toThrow();
    expect('opener' in runtime.window).toBe(false);
    vi.advanceTimersByTime(OAUTH_SUCCESS_AUTO_CLOSE_DELAY_MS);
    expect(runtime.elements['close-status'].textContent).toMatch(
      /close this tab and return to Agor/
    );
  });

  it('starts only one timer set if the success script is evaluated more than once', () => {
    const page = renderOAuthResultPage(true, 'Connected.');
    const runtime = confirmationRuntime();
    const script = inlineScript(page.html);

    runtime.run(script);
    runtime.run(script);
    vi.advanceTimersByTime(OAUTH_SUCCESS_AUTO_CLOSE_DELAY_MS);

    expect(runtime.window.close).toHaveBeenCalledOnce();
    expect(runtime.window.addEventListener).toHaveBeenCalledOnce();
  });

  it('cleans up both timers when the page is discarded', () => {
    const page = renderOAuthResultPage(true, 'Connected.');
    const runtime = confirmationRuntime();
    runtime.run(inlineScript(page.html));

    vi.advanceTimersByTime(1_000);
    runtime.pagehide();
    vi.advanceTimersByTime(OAUTH_SUCCESS_AUTO_CLOSE_DELAY_MS);

    expect(runtime.window.close).not.toHaveBeenCalled();
    expect(runtime.elements['close-countdown'].textContent).toBe('2 seconds');
  });

  it('never adds timers or close script to error, denied, or recovery pages', () => {
    const page = renderOAuthResultPage(false, '<provider error>');

    expect(page.html).toContain('Authentication not completed');
    expect(page.html).toContain('&lt;provider error&gt;');
    expect(page.html).not.toContain('<script');
    expect(page.html).not.toContain('window.close');
    expect(page.html).not.toContain('close-countdown');
    expect(page.contentSecurityPolicy).not.toContain('script-src');
  });
});
