/** Playwright stays a UI-owned test dependency; no production module imports this. */
export { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
