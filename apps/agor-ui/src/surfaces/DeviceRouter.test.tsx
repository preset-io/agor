import type { Board } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agorStore } from '../store/agorStore';
import { DeviceRouter } from './DeviceRouter';

const viewport = vi.hoisted(() => ({ isMobile: false }));
vi.mock('../hooks/useIsMobileViewport', () => ({
  useIsMobileViewport: () => viewport.isMobile,
}));

const BOARD_ID = '01a012d8-1b9b-7909-b6f4-2024dfc7c51e';
const SESSION_ID = '01a012d8-4f50-7c32-9daa-6e3f70819b2c';
const SESSION_TOKEN = '01a012d84f507c329daa6e3f';

function CurrentPath() {
  const { pathname } = useLocation();
  return (
    <div data-testid="path" data-navigation={useNavigationType()}>
      {pathname}
    </div>
  );
}

function tree() {
  return (
    <>
      <DeviceRouter />
      <Routes>
        <Route path="*" element={<CurrentPath />} />
      </Routes>
    </>
  );
}

function renderAt(path: string) {
  return render(<MemoryRouter initialEntries={[path]}>{tree()}</MemoryRouter>);
}

const currentPath = () => screen.getByTestId('path').textContent;

afterEach(() => {
  viewport.isMobile = false;
  agorStore.getState().reset();
});

describe('DeviceRouter', () => {
  it('sends a narrow viewport on a desktop route to the mobile shell, replacing the history entry', () => {
    viewport.isMobile = true;
    renderAt('/');
    expect(currentPath()).toBe('/m');
    expect(screen.getByTestId('path')).toHaveAttribute('data-navigation', 'REPLACE');
  });

  it('sends a wide viewport on a mobile route to the desktop shell', () => {
    renderAt('/m');
    expect(currentPath()).toBe('/');
  });

  it.each([
    [true, `/s/${SESSION_TOKEN}/`, `/m/session/${SESSION_TOKEN}`],
    [false, `/m/session/${SESSION_ID}`, `/s/${SESSION_TOKEN}/`],
  ])('keeps the open session when switching shells (mobile=%s)', (isMobile, from, to) => {
    viewport.isMobile = isMobile;
    renderAt(from);
    expect(currentPath()).toBe(to);
  });

  it('routes a board by the slug the store knows', () => {
    agorStore.setState({
      boardById: new Map([[BOARD_ID, { board_id: BOARD_ID, slug: 'delivery' } as Board]]),
    });
    renderAt(`/m/board/${BOARD_ID}`);
    expect(currentPath()).toBe('/b/delivery/');
  });

  it.each([
    [true, '/m/sessions'],
    [false, '/'],
    [false, '/b/board-1'],
  ])(
    'leaves a route alone when it already matches the shell (mobile=%s, path=%s)',
    (isMobile, path) => {
      viewport.isMobile = isMobile;
      renderAt(path);
      expect(currentPath()).toBe(path);
    }
  );

  it('leaves routes that opt out of device routing alone', () => {
    viewport.isMobile = true;
    renderAt('/knowledge');
    expect(currentPath()).toBe('/knowledge');
  });

  it('switches shells when the viewport crosses the breakpoint', () => {
    const view = renderAt('/');
    expect(currentPath()).toBe('/');
    viewport.isMobile = true;
    view.rerender(<MemoryRouter initialEntries={['/']}>{tree()}</MemoryRouter>);
    expect(currentPath()).toBe('/m');
  });
});
