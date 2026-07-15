import { act, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider, theme } from 'antd';
import { StreamdownContext } from 'streamdown';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VegaLiteRenderer } from './VegaLiteRenderer';

const mocks = vi.hoisted(() => ({
  embed: vi.fn(),
  finalize: vi.fn(),
  loadRuntime: vi.fn(),
}));

vi.mock('./vegaRuntime', () => ({ loadVegaRuntime: mocks.loadRuntime }));

const code = JSON.stringify({
  description: 'Monthly revenue',
  width: 'container',
  height: 240,
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
    mocks.loadRuntime.mockReset();
    mocks.loadRuntime.mockResolvedValue(createMockRuntime());
  });

  it('does not count a cold lazy-runtime load toward the chart render timeout', async () => {
    vi.useFakeTimers();
    let resolveRuntime: ((runtime: ReturnType<typeof createMockRuntime>) => void) | undefined;
    mocks.loadRuntime.mockReturnValue(
      new Promise((resolve) => {
        resolveRuntime = resolve;
      })
    );

    try {
      render(<VegaLiteRenderer code={code} isIncomplete={false} language="vega-lite" />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });

      expect(screen.getByText('Loading Vega-Lite chart…')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      await act(async () => {
        resolveRuntime?.(createMockRuntime());
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mocks.embed).toHaveBeenCalled();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
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
        hover: false,
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

  it('times out chart execution and finalizes a result that resolves late', async () => {
    vi.useFakeTimers();
    let resolveEmbed: ((value: { view: { finalize: () => void } }) => void) | undefined;
    mocks.embed.mockReturnValue(
      new Promise((resolve) => {
        resolveEmbed = resolve;
      })
    );

    try {
      render(<VegaLiteRenderer code={code} isIncomplete={false} language="vega-lite" />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.embed).toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });
      expect(screen.getByRole('alert')).toHaveTextContent('Chart rendering timed out');

      await act(async () => {
        resolveEmbed?.({ view: { finalize: mocks.finalize } });
        await Promise.resolve();
      });
      expect(mocks.finalize).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors Streamdown code controls being disabled', async () => {
    render(
      <StreamdownContext.Provider
        value={{
          controls: false,
          isAnimating: false,
          lineNumbers: true,
          mode: 'static',
          shikiTheme: ['github-light', 'github-dark'],
        }}
      >
        <VegaLiteRenderer code={code} isIncomplete={false} language="vega-lite" />
      </StreamdownContext.Provider>
    );

    await waitFor(() => expect(mocks.embed).toHaveBeenCalled());
    expect(screen.queryByLabelText('Copy Vega-Lite spec')).not.toBeInTheDocument();
    expect(screen.queryByText('View Vega-Lite source')).not.toBeInTheDocument();
  });
});

function createMockRuntime() {
  return {
    loader: () => ({ load: vi.fn(), sanitize: vi.fn() }),
    vegaEmbed: mocks.embed,
  };
}
