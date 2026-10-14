import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FadeText } from './FadeText';

const TITLE = 'Refactor session permissions approval flow for teams';

function setWidths({ client, scroll }: { client: number; scroll: number }) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(client);
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(scroll);
}

function matchTouch(touch: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: touch && query === '(hover: none)',
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList
  );
}

function renderTitle(props: Partial<React.ComponentProps<typeof FadeText>> = {}) {
  render(
    <button type="button">
      <FadeText data-testid="title" tooltipProps={{ mouseEnterDelay: 0 }} {...props}>
        {TITLE}
      </FadeText>
    </button>
  );
  return screen.getByTestId('title');
}

afterEach(() => vi.restoreAllMocks());

describe('FadeText', () => {
  it('fades the end only when the text is clipped', () => {
    setWidths({ client: 120, scroll: 480 });
    const clipped = renderTitle();

    expect(clipped).toHaveAttribute('data-overflowing');
    expect(clipped.style.textOverflow).toBe('clip');
    expect(clipped.style.maskImage).toContain('to right');
    expect(clipped.style.maskImage).toContain('var(--agor-fade-row-start, 24px)');
  });

  it('leaves fitting text unmasked', () => {
    setWidths({ client: 480, scroll: 480 });
    const fitting = renderTitle();

    expect(fitting).not.toHaveAttribute('data-overflowing');
    expect(fitting.style.maskImage).toBe('');
    expect(fitting.style.textOverflow).toBe('ellipsis');
  });

  it('uses the shorter fade for dense meta lines', () => {
    setWidths({ client: 120, scroll: 480 });
    expect(renderTitle({ dense: true }).style.maskImage).toContain(
      'var(--agor-fade-row-start, 12px)'
    );
  });

  it('mirrors the fade for right-to-left text', () => {
    setWidths({ client: 120, scroll: 480 });
    const title = renderTitle({ style: { direction: 'rtl' } });

    expect(title.style.maskImage).toContain('to left');
  });

  it('keeps the ellipsis on touch screens', () => {
    matchTouch(true);
    setWidths({ client: 120, scroll: 480 });
    const title = renderTitle();

    expect(title).toHaveAttribute('data-overflowing');
    expect(title.style.maskImage).toBe('');
    expect(title.style.textOverflow).toBe('ellipsis');
  });

  it('shows the full text on keyboard focus of the enclosing control when clipped', async () => {
    setWidths({ client: 120, scroll: 480 });
    renderTitle();

    act(() => screen.getByRole('button').focus());

    expect(await screen.findByRole('tooltip')).toHaveTextContent(TITLE);
  });

  it('stays closed on hover when the text fits', async () => {
    setWidths({ client: 480, scroll: 480 });
    const fitting = renderTitle();
    fireEvent.mouseEnter(fitting);
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens the hover tooltip on clipped text', async () => {
    setWidths({ client: 120, scroll: 480 });
    fireEvent.mouseEnter(renderTitle());

    expect(await screen.findByRole('tooltip')).toHaveTextContent(TITLE);
  });

  it('keeps the full text in the accessible name', () => {
    setWidths({ client: 120, scroll: 480 });
    renderTitle();

    expect(screen.getByRole('button', { name: TITLE })).toBeInTheDocument();
  });
});
