/** Playwright stays a UI-owned test dependency; no production module imports this. */
export { type Browser, chromium, type Page } from 'playwright';
