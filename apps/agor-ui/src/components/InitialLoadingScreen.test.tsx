import { render, screen } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { describe, expect, it } from 'vitest';
import { InitialLoadingScreen } from './InitialLoadingScreen';

const lightTheme = {
  token: {
    colorBgLayout: '#fafafa',
    colorTextSecondary: 'rgba(0, 0, 0, 0.65)',
  },
};

describe('InitialLoadingScreen', () => {
  it('uses Ant Design theme tokens for the page background in light mode', () => {
    const { container } = render(
      <ConfigProvider theme={lightTheme}>
        <InitialLoadingScreen message="Loading…" />
      </ConfigProvider>
    );

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveStyle({ backgroundColor: '#fafafa' });
  });

  it('renders themed checklist rows when workspace data is loading', () => {
    render(
      <ConfigProvider theme={lightTheme}>
        <InitialLoadingScreen
          items={[
            { key: 'sessions', label: 'Sessions', done: true, count: 2 },
            { key: 'boards', label: 'Boards', done: false, count: 0 },
          ]}
        />
      </ConfigProvider>
    );

    expect(screen.getByText('Loading workspace…')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('Boards')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
  });
});
