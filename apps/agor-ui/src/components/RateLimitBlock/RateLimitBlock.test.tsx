import type { Message } from '@agor/core/types';
import { render, screen } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { describe, expect, it } from 'vitest';
import { RateLimitBlock } from './RateLimitBlock.js';

describe('RateLimitBlock', () => {
  it('renders a warning icon for permission_denied sdk events without requiring is_error', () => {
    const message = {
      content: [
        {
          type: 'sdk_event',
          text: 'Permission denied: Bash — Command refused by policy',
          sdkType: 'system',
          sdkSubtype: 'permission_denied',
        },
      ],
    } as unknown as Message;

    const { container } = render(
      <ConfigProvider>
        <RateLimitBlock message={message} />
      </ConfigProvider>
    );

    expect(screen.getByText('Permission denied: Bash — Command refused by policy')).toBeVisible();
    expect(container.querySelector('.anticon-warning')).toBeInTheDocument();
    expect(container.querySelector('.anticon-info-circle')).not.toBeInTheDocument();
  });

  it('renders an info icon for ordinary sdk events even if an unexpected is_error property exists', () => {
    const message = {
      content: [
        {
          type: 'sdk_event',
          text: 'Session initialized',
          sdkType: 'system',
          sdkSubtype: 'init',
          is_error: true,
        },
      ],
    } as unknown as Message;

    const { container } = render(
      <ConfigProvider>
        <RateLimitBlock message={message} />
      </ConfigProvider>
    );

    expect(screen.getByText('Session initialized')).toBeVisible();
    expect(container.querySelector('.anticon-info-circle')).toBeInTheDocument();
    expect(container.querySelector('.anticon-warning')).not.toBeInTheDocument();
  });

  it('preserves the warning icon for allowed rate_limit events', () => {
    const message = {
      content: [
        {
          type: 'rate_limit',
          text: 'Rate limit allowed',
          status: 'allowed',
        },
      ],
    } as unknown as Message;

    const { container } = render(
      <ConfigProvider>
        <RateLimitBlock message={message} />
      </ConfigProvider>
    );

    expect(container.querySelector('.anticon-warning')).toBeInTheDocument();
    expect(container.querySelector('.anticon-clock-circle')).not.toBeInTheDocument();
  });

  it('renders a clock icon for api_wait notices', () => {
    const message = {
      content: [
        {
          type: 'api_wait',
          text: 'Waiting for response...',
          elapsedSeconds: 30,
        },
      ],
    } as unknown as Message;

    const { container } = render(
      <ConfigProvider>
        <RateLimitBlock message={message} />
      </ConfigProvider>
    );

    expect(screen.getByText('Waiting for response...')).toBeVisible();
    expect(container.querySelector('.anticon-clock-circle')).toBeInTheDocument();
  });

  it('renders a warning icon for allowed_warning and rejected rate limits', () => {
    const message = {
      content: [
        {
          type: 'rate_limit',
          status: 'rejected',
          rateLimitType: 'five_hour',
        },
      ],
    } as unknown as Message;

    const { container } = render(
      <ConfigProvider>
        <RateLimitBlock message={message} settled />
      </ConfigProvider>
    );

    expect(screen.getByText('Rate limited (five_hour).')).toBeVisible();
    expect(container.querySelector('.anticon-warning')).toBeInTheDocument();
  });
});
