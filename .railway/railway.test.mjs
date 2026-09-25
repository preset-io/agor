import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import configuration from './railway.ts';

test('SQLite bootstrap is one source-built service with private persistent state', async () => {
  const { resources } = await configuration({});
  assert.equal(resources.length, 2);
  const app = resources.find((resource) => resource.type === 'service');
  const data = resources.find((resource) => resource.type === 'volume');
  assert.equal(app.source.repo, 'preset-io/agor');
  assert.equal(app.build.dockerfilePath, 'docker/Dockerfile');
  assert.equal(app.variables.AGOR_RUNTIME_TARGET.value, 'runtime-build');
  assert.deepEqual(app.deploy.multiRegionConfig, { sfo: { numReplicas: 1 } });
  assert.equal(app.deploy.healthcheckPath, '/health');
  assert.equal(app.deploy.healthcheckTimeout, 600);
  assert.equal(app.variables.AGOR_SOURCE_BRANCH.value, app.source.branch);
  assert.equal(app.variables.AGOR_SOURCE_REPO.value, 'https://github.com/preset-io/agor.git');
  assert.equal(app.deploy.overlapSeconds, 0);
  assert.equal(app.deploy.preDeployCommand, undefined);
  assert.equal(app.volumeAttachments['agor-preview-data'].volume, data.address);
  assert.equal(app.volumeAttachments['agor-preview-data'].mountPath, '/home/agor/.agor');
  assert.equal(data.config.sizeMB, 5000);
  assert.equal(app.variables.PORT.value, app.variables.DAEMON_PORT.value);
  assert.equal(app.variables.CORS_ORIGIN.value, app.variables.AGOR_BASE_URL.value);
  assert.notEqual(app.variables.CORS_ORIGIN.value, '*');
  for (const key of ['RAILWAY_TOKEN', 'RAILWAY_API_TOKEN', 'RAILWAY_API_KEY']) {
    assert.equal(app.variables[key], undefined);
  }
  assert.equal(app.variables.AGOR_ADMIN_PASSWORD.type, 'preserve');
  assert.equal(app.variables.AGOR_RUNTIME_ADD_TOOLS.value, 'claude-code,codex,opencode,copilot');
  assert.equal(app.variables.AGOR_AGENTIC_TOOLS.value, app.variables.AGOR_RUNTIME_ADD_TOOLS.value);
});

test('platform runtime selection preserves explicit Docker targets and historical default', async () => {
  const dockerfile = await readFile(new URL('../docker/Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /ARG AGOR_RUNTIME_TARGET=production-source-ha/);
  assert.match(dockerfile, /FROM base AS production-source\n/);
  assert.match(dockerfile, /FROM production-source AS production-source-ha\n/);
  assert.match(dockerfile, /FROM \$\{AGOR_RUNTIME_TARGET\} AS runtime\s*$/);
});
