import { cleanup, configure, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';
import { ThemeProvider } from '../contexts/ThemeContext';
import { checkBrowserSanity } from '../test/browserSanity';
import { MarketingScreenshotPage } from './MarketingScreenshotPage';
import { MarketingVideoPage } from './marketing/MarketingVideoPage';

checkBrowserSanity();
configure({ asyncUtilTimeout: 10_000 });
afterEach(cleanup);

it.each([
  ['/demo/marketing-screenshots', 'marketing-screenshot-page'],
  ['/demo/marketing-video', 'marketing-video-page'],
])('renders the real provider-free marketing route %s', async (path, testId) => {
  render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/demo/marketing-screenshots" element={<MarketingScreenshotPage />} />
          <Route path="/demo/marketing-video" element={<MarketingVideoPage />} />
        </Routes>
      </MemoryRouter>
    </ThemeProvider>
  );
  expect(await screen.findByTestId(testId)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Open MCP Catalog' })).not.toBeInTheDocument();
});
