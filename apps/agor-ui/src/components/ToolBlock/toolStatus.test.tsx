import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { deriveToolStatus, renderToolStatusIcon } from './toolStatus';

describe('tool status presentation', () => {
  it('keeps unfinished tools neutral while agent progress is stalled', async () => {
    const status = deriveToolStatus({
      hasResult: false,
      isPotentiallyRunning: true,
      taskProgressState: 'stalled',
    });

    expect(status).toBe('stalled');
    render(renderToolStatusIcon(status));
    fireEvent.mouseEnter(screen.getByRole('img', { name: 'clock-circle' }));
    expect(await screen.findByText('Agent progress stalled')).toBeInTheDocument();
    expect(screen.queryByText(/Agent moved on/)).not.toBeInTheDocument();
  });
});
