import { render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider, theme } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VegaLiteRenderer } from './VegaLiteRenderer';

const mocks = vi.hoisted(() => ({
  embed: vi.fn(),
  finalize: vi.fn(),
}));

vi.mock('vega-embed', () => ({ default: mocks.embed }));
vi.mock('vega', () => ({
  loader: () => ({
    load: vi.fn(),
    sanitize: vi.fn(),
  }),
}));

const code = JSON.stringify({
  description: 'Monthly revenue',
  data: { values: [{ month: 'Jan', revenue: 28 }] },
  mark: 'bar',
  encoding: {
    x: { field: 'month', type: 'nominal' },
    y: { field: 'revenue', type: 'quantitative' },
  },
});

describe('VegaLiteRenderer', () => {
  beforeEach(() => {
    mocks.embed.mockReset();
    mocks.finalize.mockReset();
    mocks.embed.mockImplementation(async (element: HTMLElement) => {
      element.append(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
      return { view: { finalize: mocks.finalize } };
    });
  });

  it('renders an accessible chart with CSP and network protections', async () => {
    const { container } = render(
      <VegaLiteRenderer code={code} isIncomplete={false} language="vega-lite" />
    );

    expect(screen.getByText('Loading Vega-Lite chart…')).toBeInTheDocument();
    const chart = screen.getByLabelText('Monthly revenue');
    expect(chart).toHaveAttribute('aria-busy', 'true');

    await waitFor(() => expect(chart).toHaveAttribute('aria-busy', 'false'));
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(mocks.embed).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ description: 'Monthly revenue' }),
      expect.objectContaining({
        actions: false,
        ast: true,
        mode: 'vega-lite',
        renderer: 'svg',
        tooltip: false,
      })
    );

    const options = mocks.embed.mock.calls[0][2];
    await expect(options.loader.load('https://example.com/data.json')).rejects.toThrow(
      /Remote Vega resource blocked/
    );
  });

  it('uses Vega dark mode under the Ant Design dark theme', async () => {
    render(
      <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
        <VegaLiteRenderer code={code} isIncomplete={false} language="vega-lite" />
      </ConfigProvider>
    );

    await waitFor(() => expect(mocks.embed).toHaveBeenCalled());
    expect(mocks.embed.mock.calls[0][2]).toEqual(expect.objectContaining({ theme: 'dark' }));
  });

  it('shows the original copyable fence when parsing fails', async () => {
    render(<VegaLiteRenderer code={'{"mark":'} isIncomplete={false} language="vega-lite" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not parse');
    expect(screen.getByText(/"mark"/)).toBeInTheDocument();
    expect(mocks.embed).not.toHaveBeenCalled();
  });
});
