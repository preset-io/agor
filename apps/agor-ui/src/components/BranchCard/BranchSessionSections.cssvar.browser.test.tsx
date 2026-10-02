// biome-ignore-all lint/plugin/noHardcodedColorLiteral: distinctive theme seeds verify each card scope resolves its own parent tokens
import type { Branch, Session } from '@agor-live/client';
import { cleanup, render, screen } from '@testing-library/react';
import { ConfigProvider, type MappingAlgorithm, type ThemeConfig, theme } from 'antd';
import { afterEach, expect, it } from 'vitest';
import { BranchSessionSections } from './BranchSessionSections';

const DARK: ThemeConfig = { algorithm: theme.darkAlgorithm };
const LIGHT: ThemeConfig = { algorithm: theme.defaultAlgorithm };
const CUSTOM: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: { colorTextBase: '#c0ffee', colorBgBase: '#102030' },
};

// Two Tree algorithms that agree on the parent's tokens (motion on) and only diverge
// under the card's `motion: false`, so the parents' computed-token hashes are identical.
const HOVER_ON_NO_MOTION = '#ff0000';
const hoverOnNoMotion: MappingAlgorithm = (seed) => ({
  ...theme.defaultAlgorithm(seed),
  ...(seed.motion === false ? { nodeHoverBg: HOVER_ON_NO_MOTION } : {}),
});
const TREE_DEFAULT: ThemeConfig = { components: { Tree: { algorithm: theme.defaultAlgorithm } } };
const TREE_HOVER: ThemeConfig = { components: { Tree: { algorithm: hoverOnNoMotion } } };

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

const Board = ({
  count,
  swap = false,
  dark = swap ? LIGHT : DARK,
  light = swap ? DARK : LIGHT,
}: {
  count: number;
  swap?: boolean;
  dark?: ThemeConfig;
  light?: ThemeConfig;
}) => (
  <>
    <ConfigProvider theme={dark}>
      <Cards count={count} testId="dark" />
    </ConfigProvider>
    <ConfigProvider theme={light}>
      <Cards count={count} testId="light" />
    </ConfigProvider>
  </>
);

const ParentTokenKey = ({ testId }: { testId: string }) => {
  const { token } = theme.useToken();
  return <span data-testid={testId}>{(token as { _tokenKey?: string })._tokenKey}</span>;
};

/** Each card tree renders its parent theme's tokens, with the card motion override. */
function expectTreeTokens(testId: string, config: ThemeConfig) {
  const expected = theme.getDesignToken({ ...config, token: { ...config.token, motion: false } });
  const trees = screen.getByTestId(testId).querySelectorAll<HTMLElement>('.ant-tree');
  expect(trees.length).toBeGreaterThan(0);
  for (const tree of trees) {
    const vars = getComputedStyle(tree);
    expect(vars.getPropertyValue('--ant-color-text')).toBe(expected.colorText);
    expect(vars.getPropertyValue('--ant-color-bg-container')).toBe(expected.colorBgContainer);
    expect(vars.getPropertyValue('--ant-motion-duration-mid')).toBe(expected.motionDurationMid);
  }
}

/** Resolved `--ant-tree-node-hover-bg` of every card tree in one board container. */
const treeHoverBgs = (testId: string) =>
  Array.from(screen.getByTestId(testId).querySelectorAll<HTMLElement>('.ant-tree'), (tree) =>
    getComputedStyle(tree).getPropertyValue('--ant-tree-node-hover-bg')
  );

/** `<style>` tags whose CSS targets a card-owned cssVar scope. */
const cardScopeStyles = () =>
  Array.from(document.querySelectorAll('style')).filter((style) =>
    /\.agor-card(-session-tree)?-/.test(style.textContent ?? '')
  );

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

it('gives parents with equal tokens but different algorithms separate scopes', () => {
  render(
    <>
      <Board count={2} dark={TREE_DEFAULT} light={TREE_HOVER} />
      <ConfigProvider theme={TREE_DEFAULT}>
        <ParentTokenKey testId="plain-token-key" />
      </ConfigProvider>
      <ConfigProvider theme={TREE_HOVER}>
        <ParentTokenKey testId="hover-token-key" />
      </ConfigProvider>
    </>
  );
  // Precondition: the parents' computed tokens hash identically.
  const plainTokenKey = screen.getByTestId('plain-token-key').textContent;
  expect(plainTokenKey).toBeTruthy();
  expect(screen.getByTestId('hover-token-key').textContent).toBe(plainTokenKey);

  // Each tree resolves its own parent's no-motion Tree tokens, not whichever wrote last.
  for (const value of treeHoverBgs('dark')) {
    expect(value).toBeTruthy();
    expect(value).not.toBe(HOVER_ON_NO_MOTION);
  }
  for (const value of treeHoverBgs('light')) expect(value).toBe(HOVER_ON_NO_MOTION);
  const plain = cardScopes('dark');
  const hover = cardScopes('light');
  expect([...plain].some((cls) => hover.has(cls))).toBe(false);
});

it('moves cards to a fresh scope when switching to a previously unused theme', () => {
  const { rerender } = render(<Board count={3} />);
  const darkScopes = cardScopes('dark');

  rerender(<Board count={3} dark={CUSTOM} />);
  expectTreeTokens('dark', CUSTOM);
  expectTreeTokens('light', LIGHT);
  const customScopes = cardScopes('dark');
  expect(customScopes.size).toBe(2);
  expect([...customScopes].some((cls) => darkScopes.has(cls) || cardScopes('light').has(cls))).toBe(
    false
  );
});

it('keeps a shared scope until its last card unmounts', () => {
  const { rerender } = render(<Board count={3} />);
  const styles = cardScopeStyles();
  expect(styles.length).toBeGreaterThan(0);

  // Unmounting some cards leaves the shared scope's styles for the rest.
  rerender(<Board count={1} />);
  expect(cardScopeStyles()).toEqual(styles);
  expectTreeTokens('dark', DARK);
  expectTreeTokens('light', LIGHT);

  // The last card under each theme takes the scope's styles with it.
  rerender(<Board count={0} />);
  expect(cardScopeStyles()).toHaveLength(0);
});
