import type { AgorClient, Branch, Session } from '@agor-live/client';
import { act, cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../index.css';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { useAgorData } from '../../hooks/useAgorData';
import { agorStore, useAgorStore } from '../../store/agorStore';
import { flushRealtimeNow } from '../../store/realtimeBatch';
import { BranchSessionSections } from './BranchSessionSections';

const branch = {
  branch_id: 'fictional-branch',
  name: 'fictional/long-running-qa',
  created_by: 'fictional-user',
  filesystem_status: 'ready',
} as Branch;

const runningSession = {
  session_id: 'fictional-session',
  created_by: 'fictional-user',
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
  return within(
    screen.getByLabelText(/Open session Fictional long-running browser QA/i)
  ).queryByRole('img', { name: 'Running' });
}

afterEach(cleanup);

describe('Branch Session active indicator in a real browser', () => {
  it('runs indefinitely, stops for authoritative terminal state, and restarts on active remount', async () => {
    const view = renderIndicator(runningSession);
    const firstSpinner = rowSpinner();
    expect(firstSpinner).not.toBeNull();
    expect(firstSpinner).toHaveClass('anticon-spin');
    expect(firstSpinner).toBeVisible();

    const style = getComputedStyle(firstSpinner!);
    expect(style.animationName).toBe('spinRotate');
    expect(style.animationIterationCount).toBe('infinite');
    expect(style.animationPlayState).toBe('running');
    const firstAnimation = firstSpinner!.getAnimations()[0];
    expect(firstAnimation?.playState).toBe('running');
    const before = Number(firstAnimation?.currentTime);
    // Observe actual animation progress; a fixed sleep can finish before the
    // first compositor frame on a busy multi-viewport browser runner.
    await expect.poll(() => Number(firstAnimation?.currentTime)).toBeGreaterThan(before);

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
    expect(reducedCss).toContain('.anticon.anticon-spin');
    const spinnerRule = mediaRules
      .flatMap((rule) => Array.from(rule.cssRules))
      .find(
        (rule): rule is CSSStyleRule =>
          rule instanceof CSSStyleRule && rule.selectorText.includes('.anticon.anticon-spin')
      );
    expect(spinnerRule?.style.animationName).toBe('none');

    // The shared Session row uses a loading icon, not Ant Spin's four dots.
    // Reduced motion removes its rotation, not its visible progress glyph.
    expect(rowSpinner()).toHaveClass('anticon-spin');
    expect(rowSpinner()).toBeVisible();
    expect(rowSpinner()?.querySelector('svg')).not.toBeNull();
  });
});

// Only the transport is controlled: the production hook, store, branch row and
// real CSS animation drive this smoke, rather than rerendering a terminal prop.
it.each(['dirty', 'failure'])(
  'settles the production socket-to-spinner path after a %s confirmation',
  async (mode) => {
    agorStore.getState().reset();
    const listeners = new Map<string, Set<(session: Session) => void>>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let confirm!: () => void;
    const confirmation = new Promise<void>((resolve) => {
      confirm = resolve;
    });
    let reads = 0;
    const terminal = { ...runningSession, status: 'idle' as const, ready_for_prompt: true };
    const emit = () => {
      for (const listener of listeners.get('sessions:patched') ?? []) listener(terminal);
    };
    const client = {
      service: (name: string) => {
        const seed = name === 'sessions' ? [runningSession] : name === 'branches' ? [branch] : [];
        return {
          find: async () => seed,
          findAll: async () => seed,
          get: async () => {
            reads++;
            if (reads === 1) {
              await gate;
              if (mode === 'failure') throw new Error('temporary server error');
              return runningSession;
            }
            await confirmation;
            return terminal;
          },
          on: (event: string, listener: (session: Session) => void) => {
            const key = `${name}:${event}`;
            const set = listeners.get(key) ?? new Set();
            set.add(listener);
            listeners.set(key, set);
          },
          removeListener: (event: string, listener: (session: Session) => void) => {
            listeners.get(`${name}:${event}`)?.delete(listener);
          },
        };
      },
      io: { on: () => {}, off: () => {} },
    } as unknown as AgorClient;
    const { result } = renderHook(() =>
      useAgorData(client, {
        authenticatedUserId: 'fictional-user',
        authenticatedUserRole: 'member',
        authGeneration: 1,
      })
    );
    await waitFor(() => expect(result.current.initialLoadComplete).toBe(true));
    // Let the initial background hydration finish before injecting the race.
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    function LiveIndicator() {
      const session = useAgorStore((state) => state.sessionById.get(runningSession.session_id));
      return session ? (
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
      ) : null;
    }
    await waitFor(() =>
      expect(agorStore.getState().sessionById.get(runningSession.session_id)).toMatchObject(
        runningSession
      )
    );
    render(<LiveIndicator />);
    const spinner = rowSpinner();
    expect(spinner).not.toBeNull();
    const animation = spinner!.getAnimations()[0];
    expect(animation.playState).toBe('running');
    act(emit);
    if (mode === 'dirty')
      act(() => {
        for (let i = 0; i < 20; i++) emit();
      });
    expect(reads).toBe(1);
    expect(rowSpinner()).toBe(spinner);
    const before = Number(animation.currentTime);
    await expect.poll(() => Number(animation.currentTime)).toBeGreaterThan(before);
    await act(async () => release());
    expect(rowSpinner()).toBe(spinner);
    await waitFor(() => expect(reads).toBe(2));
    // The follow-up is deliberately pending too: retention must not depend
    // on the runner completing an assertion before the retry delay elapses.
    expect(rowSpinner()).toBe(spinner);
    await act(async () => confirm());
    act(() => flushRealtimeNow('fictional-user:member:1'));
    await waitFor(() => expect(rowSpinner()).toBeNull());
    expect(spinner!.isConnected).toBe(false);
    expect(agorStore.getState().sessionById.get(runningSession.session_id)?.status).toBe('idle');
  }
);
