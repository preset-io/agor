import type { Branch, Session, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';

vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();

  const MockTree = ({ treeData, expandedKeys = [], onExpand, switcherIcon, titleRender }: any) => {
    const expandedKeySet = new Set(expandedKeys);

    const renderNodes = (nodes: any[]) =>
      nodes.map((node) => {
        const hasChildren = Boolean(node.children?.length);
        const expanded = expandedKeySet.has(node.key);
        const nextExpandedKeys = expanded
          ? expandedKeys.filter((key: React.Key) => key !== node.key)
          : [...expandedKeys, node.key];
        const title = titleRender ? titleRender(node) : node.title;

        const renderedSwitcher = switcherIcon?.({
          eventKey: node.key,
          expanded,
          isLeaf: !hasChildren,
          session: node.session,
        });

        return (
          <div key={node.key}>
            {hasChildren &&
              (renderedSwitcher ?? (
                <button
                  type="button"
                  aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.session.title}`}
                  onClick={() => onExpand?.(nextExpandedKeys)}
                />
              ))}
            {title}
            {hasChildren && expanded && <div>{renderNodes(node.children)}</div>}
          </div>
        );
      });

    return <div role="tree">{renderNodes(treeData)}</div>;
  };

  return {
    ...actual,
    Tree: MockTree,
  };
});

const [{ App: AntApp }, { BranchSessionSections }] = await Promise.all([
  import('antd'),
  import('./BranchSessionSections'),
]);

const branch = {
  branch_id: 'branch-1',
  name: 'feature/cleanup',
  filesystem_status: 'ready',
} as Branch;

const scheduledSession = {
  session_id: 'session-scheduled-1',
  branch_id: 'branch-1',
  title: 'Clean up board',
  agentic_tool: 'codex',
  status: 'idle',
  archived: false,
  scheduled_from_branch: true,
  scheduled_run_at: 1_780_527_200_000,
  created_at: '2026-06-03T00:00:00.000Z',
  last_updated: '2026-06-03T00:00:00.000Z',
} as unknown as Session;

function makeManualSession(
  overrides: { session_id: string; title: string } & Record<string, unknown>
): Session {
  return {
    branch_id: 'branch-1',
    agentic_tool: 'codex',
    status: 'idle',
    archived: false,
    created_at: '2026-06-03T00:00:00.000Z',
    last_updated: '2026-06-03T00:00:00.000Z',
    genealogy: { children: [] },
    ...overrides,
  } as unknown as Session;
}

function getSessionTreeToggle(sessionTitle: string): HTMLElement {
  const mockedToggle = screen.queryByLabelText(
    new RegExp(`(collapse|expand) ${sessionTitle}`, 'i')
  );
  if (mockedToggle) return mockedToggle;

  const titleElement = screen.getByText(sessionTitle);
  const treeNode = titleElement.closest('.ant-tree-treenode');
  const switcher = treeNode?.querySelector<HTMLElement>(
    ':scope > .ant-tree-switcher:not(.ant-tree-switcher-noop)'
  );
  if (!switcher) {
    throw new Error(`Unable to find tree toggle for ${sessionTitle}`);
  }

  return switcher;
}

function renderSections(props: Partial<React.ComponentProps<typeof BranchSessionSections>> = {}) {
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
          sessions={[scheduledSession]}
          userById={new Map<string, User>()}
          onSessionClick={vi.fn()}
          onCreateSession={vi.fn()}
          client={null}
          {...props}
        />
      </AntApp>
    </ConnectionProvider>
  );
}

describe('BranchSessionSections', () => {
  it('keeps the new-session affordance visible when only scheduled runs remain', () => {
    renderSections();

    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('Scheduled Runs')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new session/i })).toBeInTheDocument();
  });

  it('marks a failed session', () => {
    const failedSession = makeManualSession({
      session_id: 'session-failed-task',
      title: 'Investigate crash',
      status: 'failed',
    });

    renderSections({ sessions: [failedSession] });

    expect(screen.getByText('Investigate crash')).toBeInTheDocument();
    expect(screen.getByLabelText('Latest task failed')).toBeInTheDocument();
  });

  it('does not mark idle sessions as failures', () => {
    const stoppedSession = makeManualSession({
      session_id: 'session-stopped-task',
      title: 'Stopped by user',
    });

    renderSections({ sessions: [stoppedSession] });

    expect(screen.getByText('Stopped by user')).toBeInTheDocument();
    expect(screen.queryByLabelText('Latest task failed')).not.toBeInTheDocument();
  });

  it('counts and renders only visible manual sessions when archived ancestors are filtered out', () => {
    const archivedParent = makeManualSession({
      session_id: 'session-archived-parent',
      title: 'Archived parent',
      archived: true,
      genealogy: { children: ['session-visible-child'] },
    });
    const visibleChild = makeManualSession({
      session_id: 'session-visible-child',
      title: 'Visible child',
      genealogy: { parent_session_id: 'session-archived-parent', children: [] },
    });

    renderSections({ sessions: [archivedParent, visibleChild] });

    expect(screen.queryByText('Archived parent')).not.toBeInTheDocument();
    expect(screen.getByText('Visible child')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('keeps a manually collapsed parent collapsed after selecting another session', async () => {
    const parentSession = makeManualSession({
      session_id: 'session-parent',
      title: 'Parent session',
      genealogy: { children: ['session-child'] },
    });
    const childSession = makeManualSession({
      session_id: 'session-child',
      title: 'Child session',
      genealogy: { parent_session_id: 'session-parent', children: [] },
    });
    const otherSession = makeManualSession({
      session_id: 'session-other',
      title: 'Other session',
    });
    const sessions = [parentSession, childSession, otherSession];
    const onSessionClick = vi.fn();

    const { rerender } = renderSections({
      sessions,
      selectedSessionId: 'session-parent',
      onSessionClick,
    });

    expect(screen.getByText('Child session')).toBeInTheDocument();

    fireEvent.click(getSessionTreeToggle('Parent session'));

    await waitFor(() => expect(screen.queryByText('Child session')).not.toBeInTheDocument());

    rerender(
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
            sessions={sessions.map((session) => ({ ...session }))}
            userById={new Map<string, User>()}
            selectedSessionId="session-other"
            onSessionClick={onSessionClick}
            onCreateSession={vi.fn()}
            client={null}
          />
        </AntApp>
      </ConnectionProvider>
    );

    expect(screen.queryByText('Child session')).not.toBeInTheDocument();
  });

  it('keeps a manually collapsed nested ancestor collapsed after selecting another session', async () => {
    const rootSession = makeManualSession({
      session_id: 'session-root',
      title: 'Root session',
      genealogy: { children: ['session-nested-parent'] },
    });
    const nestedParentSession = makeManualSession({
      session_id: 'session-nested-parent',
      title: 'Nested parent',
      genealogy: { parent_session_id: 'session-root', children: ['session-nested-child'] },
    });
    const nestedChildSession = makeManualSession({
      session_id: 'session-nested-child',
      title: 'Nested child',
      genealogy: { parent_session_id: 'session-nested-parent', children: [] },
    });
    const otherSession = makeManualSession({
      session_id: 'session-other',
      title: 'Other session',
    });
    const sessions = [rootSession, nestedParentSession, nestedChildSession, otherSession];

    const { rerender } = renderSections({
      sessions,
      selectedSessionId: 'session-root',
    });

    expect(screen.getByText('Nested child')).toBeInTheDocument();

    fireEvent.click(getSessionTreeToggle('Nested parent'));

    await waitFor(() => expect(screen.queryByText('Nested child')).not.toBeInTheDocument());

    rerender(
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
            sessions={sessions.map((session) => ({ ...session }))}
            userById={new Map<string, User>()}
            selectedSessionId="session-other"
            onSessionClick={vi.fn()}
            onCreateSession={vi.fn()}
            client={null}
          />
        </AntApp>
      </ConnectionProvider>
    );

    expect(screen.getByText('Nested parent')).toBeInTheDocument();
    expect(screen.queryByText('Nested child')).not.toBeInTheDocument();
    expect(getSessionTreeToggle('Nested parent')).toHaveAttribute('aria-expanded', 'false');
  });

  it('expands a session when it newly gains children', () => {
    const parentSession = makeManualSession({
      session_id: 'session-parent',
      title: 'Parent session',
    });
    const childSession = makeManualSession({
      session_id: 'session-child',
      title: 'Child session',
      genealogy: { parent_session_id: 'session-parent', children: [] },
    });

    const { rerender } = renderSections({ sessions: [parentSession] });

    expect(screen.queryByText('Child session')).not.toBeInTheDocument();

    rerender(
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
            sessions={[{ ...parentSession }, childSession]}
            userById={new Map<string, User>()}
            onSessionClick={vi.fn()}
            onCreateSession={vi.fn()}
            client={null}
          />
        </AntApp>
      </ConnectionProvider>
    );

    expect(screen.getByText('Child session')).toBeInTheDocument();
  });

  it('keeps a manually collapsed parent collapsed when it loses and regains children', async () => {
    const parentSession = makeManualSession({
      session_id: 'session-parent',
      title: 'Parent session',
      genealogy: { children: ['session-child-1'] },
    });
    const firstChild = makeManualSession({
      session_id: 'session-child-1',
      title: 'First child',
      genealogy: { parent_session_id: 'session-parent', children: [] },
    });
    const secondChild = makeManualSession({
      session_id: 'session-child-2',
      title: 'Second child',
      genealogy: { parent_session_id: 'session-parent', children: [] },
    });

    const { rerender } = renderSections({ sessions: [parentSession, firstChild] });

    expect(screen.getByText('First child')).toBeInTheDocument();

    fireEvent.click(getSessionTreeToggle('Parent session'));

    await waitFor(() => expect(screen.queryByText('First child')).not.toBeInTheDocument());

    rerender(
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
            sessions={[{ ...parentSession, genealogy: { children: [] } }]}
            userById={new Map<string, User>()}
            onSessionClick={vi.fn()}
            onCreateSession={vi.fn()}
            client={null}
          />
        </AntApp>
      </ConnectionProvider>
    );

    expect(screen.queryByLabelText(/(collapse|expand) parent session/i)).not.toBeInTheDocument();

    rerender(
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
            sessions={[
              { ...parentSession, genealogy: { children: ['session-child-2'] } },
              secondChild,
            ]}
            userById={new Map<string, User>()}
            onSessionClick={vi.fn()}
            onCreateSession={vi.fn()}
            client={null}
          />
        </AntApp>
      </ConnectionProvider>
    );

    expect(screen.queryByText('Second child')).not.toBeInTheDocument();
  });
});
