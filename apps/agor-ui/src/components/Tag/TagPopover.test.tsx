import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Tag } from './Tag';
import { TagPopover } from './TagPopover';

/** The clipped chrome a chip normally lives in — a session footer, a task list. */
const Clipped: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div data-testid="clipped" style={{ overflow: 'hidden' }}>
    {children}
  </div>
);

describe('TagPopover', () => {
  it('renders the popup outside the chip’s clipped ancestor', () => {
    render(
      <Clipped>
        <TagPopover trigger="click" content={<span>Popup body</span>}>
          <Tag>chip</Tag>
        </TagPopover>
      </Clipped>
    );

    fireEvent.click(screen.getByText('chip'));

    const popup = screen.getByText('Popup body');
    expect(screen.getByTestId('clipped')).not.toContainElement(popup);
    expect(document.body).toContainElement(popup);
  });

  it('defaults to the top placement AntD can flip', () => {
    render(
      <TagPopover trigger="click" content={<span>Popup body</span>}>
        <Tag>chip</Tag>
      </TagPopover>
    );

    fireEvent.click(screen.getByText('chip'));

    expect(document.querySelector('.ant-popover-placement-top')).toBeInTheDocument();
  });

  it('lets a caller pick a different placement', () => {
    render(
      <TagPopover trigger="click" placement="bottomLeft" content={<span>Popup body</span>}>
        <Tag>chip</Tag>
      </TagPopover>
    );

    fireEvent.click(screen.getByText('chip'));

    expect(document.querySelector('.ant-popover-placement-bottomLeft')).toBeInTheDocument();
  });
});
