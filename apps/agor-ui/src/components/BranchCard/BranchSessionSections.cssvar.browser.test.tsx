import type { Branch, Session } from '@agor-live/client';
import { cleanup, render, screen } from '@testing-library/react';
import { ConfigProvider, type ThemeConfig, theme } from 'antd';
import { afterEach, expect, it } from 'vitest';
import { BranchSessionSections } from './BranchSessionSections';

const DARK: ThemeConfig = { algorithm: theme.darkAlgorithm };
const LIGHT: ThemeConfig = { algorithm: theme.defaultAlgorithm };

function makeBranch(index: number): { branch: Branch; sessions: Session[] } {
  const branch = {
    branch_id: `cssvar-branch-${index}`,
    name: `Branch ${index}`,
    filesystem_status: 'ready',
  } as Branch;
  const sessions = [
    {
      session_id: `cssvar-session-${index}` as Session['session_id'],
      branch_id: branch.branch_id,
      title: `Session ${index}`,
      agentic_tool: 'codex',
      status: 'idle',
      archived: false,
      created_by: 'user-1',
      tasks: [],
      ready_for_prompt: false,
      created_at: '2026-09-01T00:00:00.000Z',
      last_updated: '2026-09-01T00:00:00.000Z',
      genealogy: { children: [] },
    } as unknown as Session,
  ];
  return { branch, sessions };
}

const Cards = ({ count, testId }: { count: number; testId: string }) => (
  <div data-testid={testId}>
    {Array.from({ length: count }, (_, index) => {
      const { branch, sessions } = makeBranch(index);
      return (
        <BranchSessionSections
          key={branch.branch_id}
          branch={branch}
          sessions={sessions}
          userById={new Map()}
          client={null}
        />
      );
    })}
  </div>
);

const Board = ({ count, swap = false }: { count: number; swap?: boolean }) => (
  <>
    <ConfigProvider theme={swap ? LIGHT : DARK}>
      <Cards count={count} testId="dark" />
    </ConfigProvider>
    <ConfigProvider theme={swap ? DARK : LIGHT}>
      <Cards count={count} testId="light" />
    </ConfigProvider>
  </>
);

/** Each card tree renders its parent theme's tokens, with the card motion override. */
function expectTreeTokens(testId: string, config: ThemeConfig) {
  const expected = theme.getDesignToken({ ...config, token: { motion: false } });
  const trees = screen.getByTestId(testId).querySelectorAll<HTMLElement>('.ant-tree');
  expect(trees.length).toBeGreaterThan(0);
  for (const tree of trees) {
    const vars = getComputedStyle(tree);
    expect(vars.getPropertyValue('--ant-color-text')).toBe(expected.colorText);
    expect(vars.getPropertyValue('--ant-color-bg-container')).toBe(expected.colorBgContainer);
    expect(vars.getPropertyValue('--ant-motion-duration-mid')).toBe(expected.motionDurationMid);
  }
}

/** Distinct antd cssVar scopes that have style tags in the document. */
const styleScopes = () =>
  new Set(
    Array.from(document.querySelectorAll('style[data-token-hash]'), (style) =>
      style.getAttribute('data-token-hash')
    )
  );

/** Card-owned cssVar scope classes used inside one board container. */
const cardScopes = (testId: string) =>
  new Set(
    Array.from(screen.getByTestId(testId).querySelectorAll('[class*="agor-"]')).flatMap((el) =>
      Array.from(el.classList).filter((cls) => /^agor-(card|card-session-tree)-/.test(cls))
    )
  );

afterEach(cleanup);

it('shares one cssVar scope per card theme instead of one per card', () => {
  const { rerender } = render(<Board count={1} />);
  const oneCardScopes = styleScopes();
  const oneCardStyles = document.querySelectorAll('style[data-token-hash]').length;

  rerender(<Board count={12} />);
  expect(screen.getAllByRole('button', { name: /^Open session / })).toHaveLength(24);
  expect(styleScopes()).toEqual(oneCardScopes);
  expect(document.querySelectorAll('style[data-token-hash]')).toHaveLength(oneCardStyles);

  // Each parent theme gets exactly one card scope and one tree scope...
  const dark = cardScopes('dark');
  const light = cardScopes('light');
  expect(dark.size).toBe(2);
  expect(light.size).toBe(2);
  // ...and different parent tokens never share one.
  expect([...dark].some((cls) => light.has(cls))).toBe(false);
});

it('keeps each parent theme’s tokens in its scope, including after a theme switch', () => {
  const { rerender } = render(<Board count={3} />);
  expectTreeTokens('dark', DARK);
  expectTreeTokens('light', LIGHT);

  // Swapping parents moves each card set to the other theme's scope, with no stale tokens.
  rerender(<Board count={3} swap />);
  expectTreeTokens('dark', LIGHT);
  expectTreeTokens('light', DARK);
});
