import type { Branch, Session } from '@agor-live/client';
import { act, cleanup, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../index.css';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { BranchSessionSections } from './BranchSessionSections';

const branch = {
  branch_id: 'fictional-branch',
  name: 'fictional/long-running-qa',
  filesystem_status: 'ready',
} as Branch;

const runningSession = {
  session_id: 'fictional-session',
  branch_id: branch.branch_id,
  title: 'Fictional long-running browser QA',
  agentic_tool: 'codex',
  status: 'running',
  ready_for_prompt: false,
  archived: false,
  created_at: '2026-08-31T00:00:00.000Z',
  last_updated: '2026-08-31T00:00:00.000Z',
  genealogy: { children: [] },
} as unknown as Session;

function renderIndicator(session: Session) {
  return render(
    <ConnectionProvider
      value={{
        connected: true,
        connecting: false,
        outOfSync: false,
        capturedSha: null,
        currentSha: null,
      }}
    >
      <AntApp>
        <BranchSessionSections
          branch={branch}
          sessions={[session]}
          userById={new Map()}
          onSessionClick={vi.fn()}
          onCreateSession={vi.fn()}
          client={null}
        />
      </AntApp>
    </ConnectionProvider>
  );
}

function rowSpinner(): HTMLElement | null {
  return screen
    .getByLabelText(/Open session Fictional long-running browser QA/i)
    .querySelector('.ant-spin-dot-spin');
}

afterEach(cleanup);

describe('Branch Session active indicator in a real browser', () => {
  it('runs indefinitely, stops for authoritative terminal state, and restarts on active remount', async () => {
    const view = renderIndicator(runningSession);
    const firstSpinner = rowSpinner();
    expect(firstSpinner).not.toBeNull();
    expect(firstSpinner?.querySelectorAll(':scope > .ant-spin-dot-item')).toHaveLength(4);

    const style = getComputedStyle(firstSpinner!);
    expect(style.animationName).toBe('spinRotate');
    expect(style.animationIterationCount).toBe('infinite');
    expect(style.animationPlayState).toBe('running');
    const firstAnimation = firstSpinner!.getAnimations()[0];
    expect(firstAnimation?.playState).toBe('running');
    const before = Number(firstAnimation?.currentTime);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(Number(firstAnimation?.currentTime)).toBeGreaterThan(before);

    view.rerender(
      <ConnectionProvider
        value={{
          connected: true,
          connecting: false,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <AntApp>
          <BranchSessionSections
            branch={branch}
            sessions={[{ ...runningSession, status: 'idle', ready_for_prompt: true }]}
            userById={new Map()}
            onSessionClick={vi.fn()}
            onCreateSession={vi.fn()}
            client={null}
          />
        </AntApp>
      </ConnectionProvider>
    );
    expect(rowSpinner()).toBeNull();

    view.rerender(
      <ConnectionProvider
        value={{
          connected: true,
          connecting: false,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <AntApp>
          <BranchSessionSections
            branch={branch}
            sessions={[runningSession]}
            userById={new Map()}
            onSessionClick={vi.fn()}
            onCreateSession={vi.fn()}
            client={null}
          />
        </AntApp>
      </ConnectionProvider>
    );
    const restarted = rowSpinner();
    expect(restarted).not.toBe(firstSpinner);
    expect(restarted?.getAnimations()).toHaveLength(1);
    expect(restarted?.getAnimations()[0]?.playState).toBe('running');
  });

  it('ships a clear static active affordance when reduced motion is requested', async () => {
    renderIndicator(runningSession);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    const mediaRules = Array.from(document.styleSheets).flatMap((sheet) => {
      try {
        return Array.from(sheet.cssRules).filter(
          (rule): rule is CSSMediaRule =>
            rule instanceof CSSMediaRule && rule.conditionText.includes('prefers-reduced-motion')
        );
      } catch {
        return [];
      }
    });
    const reducedCss = mediaRules.map((rule) => rule.cssText).join('\n');
    expect(reducedCss).toContain('.ant-spin .ant-spin-dot-spin');
    const spinnerRule = mediaRules
      .flatMap((rule) => Array.from(rule.cssRules))
      .find(
        (rule): rule is CSSStyleRule =>
          rule instanceof CSSStyleRule && rule.selectorText.includes('.ant-spin-dot-spin')
      );
    expect(spinnerRule?.style.animationName).toBe('none');

    // Ant's four unequal-opacity dots remain visible as a nonanimated active
    // mark; reduced motion removes only rotation, not the affordance itself.
    const dots = rowSpinner()?.querySelectorAll<HTMLElement>(':scope > .ant-spin-dot-item');
    expect(dots).toHaveLength(4);
    expect(new Set(Array.from(dots ?? [], (dot) => getComputedStyle(dot).opacity)).size).toBe(4);
  });
});
