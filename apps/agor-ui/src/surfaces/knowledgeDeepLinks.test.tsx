import { getKnowledgeUrl } from '@agor/core/utils/url';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { decodeKnowledgeRoutePath } from '../utils/knowledgeRoutes';
import { KNOWLEDGE_ROUTE_PATHS } from './surfaceRegistry';

function DocumentRoute() {
  const params = useParams();
  const location = useLocation();
  return (
    <div data-testid="document">
      {JSON.stringify({
        namespace: params.namespaceSlug,
        path: decodeKnowledgeRoutePath(params['*']),
        editing: new URLSearchParams(location.search).get('mode') === 'edit',
      })}
    </div>
  );
}

describe('server-generated Knowledge deep links', () => {
  it.each(['kb', 'knowledge'])(
    'opens the reader through /ui/%s with the actual route registry',
    (segment) => {
      const generated = new URL(getKnowledgeUrl('team', 'docs/a b.md', 'https://tenant.test'));
      const pathname = generated.pathname.replace('/kb/', `/${segment}/`);
      render(
        <MemoryRouter basename="/ui" initialEntries={[pathname]}>
          <Routes>
            {KNOWLEDGE_ROUTE_PATHS.map((path) => (
              <Route key={path} path={path} element={<DocumentRoute />} />
            ))}
          </Routes>
        </MemoryRouter>
      );
      expect(JSON.parse(screen.getByTestId('document').textContent!)).toEqual({
        namespace: 'team',
        path: 'docs/a b.md',
        editing: false,
      });
    }
  );
});
