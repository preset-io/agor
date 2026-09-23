import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('runs all four discovery commands against a synthetic read-only REST endpoint', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kb-discovery-command-'));
  const deploymentId = '019c1234-5678-7123-8123-123456789abc';
  const namespace = {
    namespace_id: '019c1234-5678-7123-8123-123456789abd',
    slug: 'synthetic',
    display_name: 'Synthetic',
    kind: 'global',
    effective_permission: 'read',
  };
  const document = {
    document_id: '019c1234-5678-7123-8123-123456789abe',
    namespace_id: namespace.namespace_id,
    path: 'nested/a.md',
    title: 'Article',
    status: 'draft',
    kind: 'doc',
  };
  const content = '# Café\r\n日本語\n';
  const requests: Array<{ method: string; path: string; query: URLSearchParams }> = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/health') {
      response.end(JSON.stringify({ service: 'agor-daemon', deploymentId, version: 'test' }));
      return;
    }
    requests.push({ method: request.method!, path: url.pathname, query: url.searchParams });
    if (request.method !== 'GET' || !request.headers.authorization) {
      response.writeHead(403);
      response.end('{}');
      return;
    }
    if (url.pathname === '/kb/namespaces') response.end(JSON.stringify([namespace]));
    else if (url.pathname === '/kb/documents') response.end(JSON.stringify([document]));
    else if (url.pathname === `/kb/documents/${document.document_id}`)
      response.end(
        JSON.stringify({
          ...document,
          document,
          content,
          current_version: { mime_type: 'text/markdown' },
          first_line_is_title: true,
        })
      );
    else {
      response.writeHead(404);
      response.end('{}');
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AGOR_API_KEY: 'agor_sk_synthetic',
    AGOR_DEPLOYMENT_ID: deploymentId,
    DAEMON_URL: `http://127.0.0.1:${address.port}`,
  };
  delete env.AGOR_OUTER_SANDBOX;
  delete env.AGOR_DATA_HOME;
  const run = (args: string[]) =>
    promisify(execFile)(
      process.execPath,
      ['--conditions=source', '--import', 'tsx', 'bin/dev.ts', 'kb', ...args],
      {
        cwd: resolve(import.meta.dirname, '../../..'),
        env,
        timeout: 30_000,
      }
    );
  try {
    const namespaces = await run(['namespace', 'list', '--json', '--limit', '1']);
    expect(JSON.parse(namespaces.stdout)).toMatchObject({
      total: 1,
      limit: 1,
      offset: 0,
      data: [{ slug: 'synthetic' }],
    });
    const show = await run(['namespace', 'show', 'synthetic', '--json']);
    expect(JSON.parse(show.stdout).slug).toBe('synthetic');
    const list = await run(['document', 'list', '--namespace', 'synthetic']);
    expect(list.stdout).toContain('nested/a.md');
    expect(list.stdout).toContain('Showing 1 of 1');
    expect(requests.some((r) => r.query.has('include_content'))).toBe(false);
    const empty = await run([
      'document',
      'list',
      '--namespace',
      'synthetic',
      '--offset',
      '10',
      '--json',
    ]);
    expect(JSON.parse(empty.stdout)).toMatchObject({ total: 1, offset: 10, data: [] });
    const get = await run(['document', 'get', 'nested/a.md', '--namespace', 'synthetic']);
    expect(get.stdout).toBe(content);
    const json = await run([
      'document',
      'get',
      'nested/a.md',
      '--namespace',
      'synthetic',
      '--json',
    ]);
    expect(JSON.parse(json.stdout).content).toBe(content);
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
    expect(
      requests
        .filter((r) => r.path === '/kb/documents')
        .every((r) => r.query.get('include_other_user_drafts') === 'true')
    ).toBe(true);
    expect(
      requests
        .filter((r) => r.path.endsWith(document.document_id))
        .every((r) => r.query.get('include_content') === 'true')
    ).toBe(true);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await rm(home, { recursive: true, force: true });
  }
}, 90_000);
