import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSupplyChainPolicy } from './check-supply-chain-security.mjs';

const safe = {
  workflow: `jobs:\n  build:\n    steps: []\n  release:\n    if: github.event_name == 'push'\n    environment: dockerhub-production\n    steps:\n      - with:\n          ref: \${{ github.sha }}\n      - uses: docker/login-action@v4\n        with:\n          password: \${{ secrets.TOKEN }}\n      - with:\n          push: true\n`,
  dockerfile: 'FROM base AS production\nRUN apt-get purge -y sudo\n',
  entrypoint: 'exec gosu agor "$0" "$@"',
};

test('accepts separated trusted publishing and an unprivileged runtime', () => {
  assert.deepEqual(checkSupplyChainPolicy(safe), []);
});

test('rejects PR-build credentials or publishing', () => {
  for (const line of ['password: ${{ secrets.TOKEN }}', 'uses: docker/login-action@v4', 'push: true']) {
    const candidate = structuredClone(safe);
    candidate.workflow = candidate.workflow.replace('steps: []', `steps:\n      - ${line}`);
    assert.match(checkSupplyChainPolicy(candidate).join('\n'), /untrusted build job/);
  }
});

test('rejects mutable or unprotected release inputs', () => {
  const candidate = structuredClone(safe);
  candidate.workflow = candidate.workflow
    .replace("if: github.event_name == 'push'", "if: github.event_name == 'pull_request'")
    .replace('environment: dockerhub-production', 'environment: preview')
    .replace('ref: ${{ github.sha }}', 'ref: ${{ github.ref }}');
  assert.equal(checkSupplyChainPolicy(candidate).length, 3);
});

test('rejects unrestricted production sudo and missing privilege drop', () => {
  const candidate = structuredClone(safe);
  candidate.dockerfile += 'RUN echo "agor ALL=(ALL) NOPASSWD:ALL"\n';
  candidate.entrypoint = 'sudo -n chown -R agor:agor /home/agor/.agor';
  assert.equal(checkSupplyChainPolicy(candidate).length, 2);
});
