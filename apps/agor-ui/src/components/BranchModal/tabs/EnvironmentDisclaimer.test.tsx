import { ENVIRONMENT } from '@agor/core/config/browser';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EnvironmentDisclaimer } from './EnvironmentDisclaimer';

describe('EnvironmentDisclaimer', () => {
  it.each([undefined, '', ' \n '])('leaves omitted/empty guidance invisible', (markdown) => {
    const { container } = render(<EnvironmentDisclaimer markdown={markdown} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders accessible, wrapping informational prose and documentation links', () => {
    const { container } = render(
      <EnvironmentDisclaimer
        markdown={
          'Commands are **bounded** and *not hosting*.\n\n- Read [setup](https://agor.live/guide/environment-configuration).\n- Check billing.'
        }
      />
    );
    const notice = screen.getByRole('note', { name: 'Environment guidance' });
    expect(notice).toHaveStyle({ minWidth: '0', overflowWrap: 'anywhere' });
    expect(container.querySelector('strong')).toHaveTextContent('bounded');
    expect(container.querySelector('em')).toHaveTextContent('not hosting');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'setup' })).toHaveAttribute(
      'href',
      'https://agor.live/guide/environment-configuration'
    );
    expect(screen.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('drops raw HTML, images, embeds, code, and interactive plugins', () => {
    const { container } = render(
      <EnvironmentDisclaimer
        markdown={[
          '<script>alert(1)</script>',
          '<a href="https://evil.example">Raw HTML link</a>',
          '<img src="https://evil.example/pixel" onerror="alert(1)">',
          '![tracker](https://evil.example/tracker)',
          '<iframe src="https://evil.example"></iframe>',
          '```mermaid\ngraph TD; A-->B\n```',
          '- [ ] Not interactive',
          'Ordinary **prose** survives.',
        ].join('\n\n')}
      />
    );
    expect(container.querySelector('script, img, iframe, input, button, pre, code')).toBeNull();
    expect(container.querySelector('svg:not([data-icon="info-circle"])')).toBeNull();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(container.querySelector('strong')).toHaveTextContent('prose');
  });

  it.each([
    'javascript:alert%281%29',
    'data:text/html,attack',
    '//evil.example',
    '/relative',
    'mailto:operator@example.com',
    'https://user:password@example.com',
    'jav&#x61;script:alert%281%29',
  ])('does not make unsafe/non-documentation URLs clickable: %s', (url) => {
    render(<EnvironmentDisclaimer markdown={`Read [the instructions](${url}).`} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('the instructions');
  });

  it('bounds input before Markdown parsing even if the server supplies oversized content', () => {
    render(
      <EnvironmentDisclaimer
        markdown={`${'x'.repeat(ENVIRONMENT.DISCLAIMER_MAX_LENGTH)}SENTINEL`}
      />
    );
    expect(screen.getByRole('note')).not.toHaveTextContent('SENTINEL');
  });
});
