import type { Session } from '@agor-live/client';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { GlobalSearch } from './GlobalSearch';
import type { GlobalSearchEntityMaps } from './types';

// Production-browser fixture: no store, network, providers, or strong fixture registry.
const root = createRoot(document.getElementById('root')!);
const refs: WeakRef<Session>[] = [];
function render(sessionById: GlobalSearchEntityMaps['sessionById']) {
  flushSync(() => {
    root.render(
      <MemoryRouter>
        <GlobalSearch
          currentUserId="fixture-user"
          sessionById={sessionById}
          branchById={new Map()}
          artifactById={new Map()}
          boardById={new Map()}
          mcpServerById={new Map()}
        />
      </MemoryRouter>
    );
  });
}

export const fixture = {
  populate(cycle: number) {
    const sessions = new Map<string, Session>();
    for (let i = 0; i < 32; i++) {
      const prefix = `RETENTION_${cycle}_${i}_`;
      const session = {
        session_id: `fixture-${cycle}-${i}`,
        branch_id: 'fixture-branch',
        created_by: 'fixture-user',
        title: `search fixture ${cycle} ${i}`,
        // Materialize independent strings so heap assertions measure payloads,
        // not just rope prefixes or absence of the session objects themselves.
        description: JSON.parse(JSON.stringify(prefix + 'x'.repeat(256 * 1024 - prefix.length))),
        last_updated: '2026-09-28T00:00:00.000Z',
        archived: false,
      } as Session;
      refs.push(new WeakRef(session));
      sessions.set(session.session_id, session);
    }
    render(sessions);
  },
  archive() {
    render(new Map());
  },
  alive() {
    return refs.filter((ref) => ref.deref() !== undefined).length;
  },
  unmount() {
    root.unmount();
  },
};

// Keep the test driver local to this entry point, not in the app's Window type.
Object.assign(window, { searchRetentionFixture: fixture });
