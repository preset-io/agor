import type { Session } from '@agor-live/client';
import { Suspense, startTransition, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { GlobalSearch } from './GlobalSearch';

// Real production React/AntD: render B, then suspend a later sibling so A stays
// committed. Do not mock search, navigation, or the control holding its handler.
const empty = new Map();
const maps = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'].map(
  (id, index) => {
    const session = {
      session_id: id,
      branch_id: 'fixture-branch',
      title: `deploy ${index === 0 ? 'A' : 'B'}`,
      created_by: 'me',
      archived: false,
      last_updated: '2026-09-28T00:00:00.000Z',
    } as Session;
    return new Map([[id, session]]);
  }
);
let attempted = false;
let blocked = true;
let resolve: () => void;
const pending = new Promise<void>((done) => {
  resolve = done;
});
function Gate({ version }: { version: number }) {
  if (version === 1 && blocked) {
    attempted = true;
    throw pending;
  }
  return <output data-testid="committed-version">{version}</output>;
}
function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}
function App() {
  const [version, setVersion] = useState(0);
  return (
    <MemoryRouter>
      <Location />
      <button type="button" onClick={() => startTransition(() => setVersion(1))}>
        Suspend replacement
      </button>
      <Suspense fallback={<p data-testid="fallback">Pending</p>}>
        <GlobalSearch
          currentUserId="me"
          sessionById={maps[version]}
          branchById={empty}
          artifactById={empty}
          boardById={empty}
          mcpServerById={empty}
        />
        <Gate version={version} />
      </Suspense>
    </MemoryRouter>
  );
}
const root = createRoot(document.getElementById('root')!);
flushSync(() => root.render(<App />));
const fixture = {
  attempted: () => attempted,
  release() {
    blocked = false;
    resolve();
  },
};
Object.assign(window, { searchConcurrentFixture: fixture });
