/**
 * The home page's optional "locked" CRT intro (components/landing/CrtIntro).
 * Off by default: `?intro=true` turns it on for this browser, `?intro=false`
 * turns it off again. An inline script in app/layout.tsx applies the flag
 * before first paint, so the page never flashes before the terminal covers it.
 *
 * <html data-crt-intro> carries the state:
 * - `locked`: the terminal is up; the hero's animations wait for it.
 * - `done`: the terminal powered off; the cursor troupe bursts out of the
 *   spot it collapsed to (until the logo is clicked for a replay).
 */
export const CRT_INTRO_ATTR = 'data-crt-intro';
export const CRT_INTRO_KEY = 'agor-crt-intro';

/** Pre-paint script: sets `locked` on the home page when the flag is on. */
export function crtIntroBootScript(basePath: string): string {
  return `(function(){try{var k=${JSON.stringify(CRT_INTRO_KEY)},q=new URLSearchParams(location.search).get('intro'),on=false;try{if(q==='true'||q==='1')localStorage.setItem(k,'1');else if(q==='false'||q==='0')localStorage.removeItem(k);on=localStorage.getItem(k)==='1'}catch(e){}if(q==='true'||q==='1')on=true;if(q==='false'||q==='0')on=false;var p=location.pathname.replace(/\\/+$/,''),b=${JSON.stringify(basePath)}.replace(/\\/+$/,'');if(on&&p===b)document.documentElement.setAttribute(${JSON.stringify(CRT_INTRO_ATTR)},'locked')}catch(e){}})();`;
}

export function crtIntroState(): string | null {
  return typeof document === 'undefined'
    ? null
    : document.documentElement.getAttribute(CRT_INTRO_ATTR);
}
