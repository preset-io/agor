// biome-ignore-all lint/plugin/noHardcodedColorLiteral: distinctive semantic theme token verifies preview color inheritance
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider, theme } from 'antd';
import { afterEach, expect, it } from 'vitest';
import imageUrl from './fixtures/preview-image.svg?no-inline';
import { MarkdownPreview } from './MarkdownPreview';
import { MarkdownRenderer } from './MarkdownRenderer';

const longContent = Array.from(
  { length: 30 },
  (_, i) => `Paragraph ${i}: a line of description.`
).join('\n\n');

afterEach(cleanup);

function viewportFor(button: HTMLElement) {
  const viewport = document.getElementById(button.getAttribute('aria-controls')!);
  if (!viewport) throw new Error('Disclosure must identify its content');
  return viewport;
}

it('bounds rendered Markdown without slicing syntax, and resets scrolling on collapse', () => {
  const { container } = render(
    <div style={{ width: 300 }}>
      <MarkdownPreview content={`**${longContent.replaceAll('\n\n', ' ')}**`} />
    </div>
  );
  const more = screen.getByRole('button', { name: 'more' });
  const viewport = viewportFor(more);
  expect(more).toHaveAttribute('aria-expanded', 'false');
  expect(viewport.clientHeight).toBe(54);
  expect(
    Number(getComputedStyle(screen.getByText(/Paragraph 29/)).fontWeight)
  ).toBeGreaterThanOrEqual(600);
  expect((container.querySelector('.markdown-compact') as HTMLElement).style.maxHeight).toBe('');
  fireEvent.click(more);
  expect(more).toHaveAttribute('aria-expanded', 'true');
  expect(viewport.clientHeight).toBe(240);
  viewport.scrollTop = 100;
  fireEvent.click(screen.getByRole('button', { name: 'less' }));
  expect(viewport.clientHeight).toBe(54);
  expect(viewport.scrollTop).toBe(0);
});

it('offers expansion after an uncached image loads without a source change', async () => {
  render(<MarkdownPreview content={`![Preview](${imageUrl}?run=${crypto.randomUUID()})`} />);
  const image = screen.getByRole('img', { name: 'Preview' }) as HTMLImageElement;
  await waitFor(() => expect(image.naturalHeight).toBe(300));
  const more = await screen.findByRole('button', { name: 'more' });
  expect(viewportFor(more).clientHeight).toBe(54);
  fireEvent.click(more);
  expect(viewportFor(more).clientHeight).toBe(240);
});

it('remeasures native disclosures and removes an unnecessary toggle after shrinking', async () => {
  const { container } = render(
    <MarkdownPreview
      content={`<details><summary>Details</summary>\n\n${longContent}\n\n</details>`}
    />
  );
  expect(screen.queryByRole('button', { name: 'more' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('Details'));
  expect(await screen.findByRole('button', { name: 'more' })).toBeInTheDocument();
  fireEvent.click(screen.getByText('Details'));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'more' })).not.toBeInTheDocument()
  );
  expect(container.querySelector('details')).not.toHaveAttribute('open');
});

it('retains a collapse action after updates, including clearing and restoring content', () => {
  const { rerender } = render(<MarkdownPreview content={longContent} />);
  fireEvent.click(screen.getByRole('button', { name: 'more' }));
  rerender(<MarkdownPreview content="Short replacement" />);
  fireEvent.click(screen.getByRole('button', { name: 'less' }));
  expect(screen.queryByRole('button', { name: 'more' })).not.toBeInTheDocument();
  rerender(<MarkdownPreview content={longContent} />);
  fireEvent.click(screen.getByRole('button', { name: 'more' }));
  rerender(<MarkdownPreview content="" />);
  rerender(<MarkdownPreview content={longContent} />);
  expect(screen.getByRole('button', { name: 'more' })).toHaveAttribute('aria-expanded', 'false');
});

it('expands when keyboard focus reaches clipped content but not a visible link', async () => {
  render(
    <MarkdownPreview
      content={`[Visible](https://example.com)\n\n${longContent}\n\n[Hidden](https://example.com)`}
    />
  );
  act(() => screen.getByRole('link', { name: 'Visible' }).focus());
  expect(screen.getByRole('button', { name: 'more' })).toHaveAttribute('aria-expanded', 'false');
  const hidden = screen.getByRole('link', { name: 'Hidden' });
  act(() => hidden.focus());
  const less = await screen.findByRole('button', { name: 'less' });
  expect(less).toHaveAttribute('aria-expanded', 'true');
  expect(hidden).toHaveFocus();
  const viewport = viewportFor(less).getBoundingClientRect();
  expect(hidden.getBoundingClientRect().top).toBeGreaterThanOrEqual(viewport.top);
  expect(hidden.getBoundingClientRect().bottom).toBeLessThanOrEqual(viewport.bottom + 1);
});

it('uses layout pixels under canvas zoom and responds to width changes', async () => {
  const { rerender } = render(
    <div style={{ width: 800, transform: 'scale(0.5)' }}>
      <MarkdownPreview content={'Word '.repeat(40)} />
    </div>
  );
  expect(screen.queryByRole('button', { name: 'more' })).not.toBeInTheDocument();
  rerender(
    <div style={{ width: 200, transform: 'scale(0.5)' }}>
      <MarkdownPreview content={'Word '.repeat(40)} />
    </div>
  );
  expect(await screen.findByRole('button', { name: 'more' })).toBeInTheDocument();
});

it('supports branch-note sizing and labels, and keeps default renderer bounds unchanged', () => {
  const { container } = render(
    <>
      <MarkdownPreview
        content={longContent}
        collapsedHeight={120}
        moreLabel="See more"
        lessLabel="See less"
      />
      <MarkdownRenderer content="Other compact caller" compact />
    </>
  );
  const more = screen.getByRole('button', { name: 'See more' });
  expect(viewportFor(more).clientHeight).toBe(120);
  fireEvent.click(more);
  expect(screen.getByRole('button', { name: 'See less' })).toBeInTheDocument();
  expect((container.querySelectorAll('.markdown-compact')[1] as HTMLElement).style.maxHeight).toBe(
    '200px'
  );
});

it('uses the secondary text token in dark/custom themes', () => {
  render(
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: { colorTextSecondary: 'rgb(123, 145, 167)' },
      }}
    >
      <MarkdownPreview content="Themed preview" />
    </ConfigProvider>
  );
  expect(getComputedStyle(screen.getByText('Themed preview')).color).toBe('rgb(123, 145, 167)');
});
