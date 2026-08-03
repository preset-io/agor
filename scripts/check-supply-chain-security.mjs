import { readFileSync } from 'node:fs';

export function checkSupplyChainPolicy({ workflow, dockerfile, entrypoint }) {
  const failures = [];
  const buildJob = workflow.match(/\n  build:\n([\s\S]*?)\n  release:\n/)?.[1] ?? '';
  const releaseJob = workflow.match(/\n  release:\n([\s\S]*)$/)?.[1] ?? '';

  if (/\$\{\{\s*secrets\.|docker\/login-action|push:\s*true/.test(buildJob)) {
    failures.push('untrusted build job may not use secrets, registry login, or push');
  }
  if (!/if:\s*github\.event_name == 'push'/.test(releaseJob)) {
    failures.push('release job must be restricted to push events');
  }
  if (!/environment:\s*dockerhub-production/.test(releaseJob)) {
    failures.push('release credentials must be protected by dockerhub-production');
  }
  if (!/ref:\s*\$\{\{ github\.sha \}\}/.test(releaseJob)) {
    failures.push('release checkout must use the immutable event SHA');
  }
  if (/NOPASSWD:ALL/.test(dockerfile.match(/FROM base AS production[\s\S]*$/)?.[0] ?? '')) {
    failures.push('production stages may not grant unrestricted sudo');
  }
  if (!/apt-get purge -y sudo/.test(dockerfile)) {
    failures.push('production images must remove sudo');
  }
  if (!/exec gosu agor/.test(entrypoint) || /sudo\b/.test(entrypoint)) {
    failures.push('production entrypoint must drop privilege without sudo');
  }
  return failures;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const failures = checkSupplyChainPolicy({
    workflow: readFileSync('.github/workflows/build-image.yml', 'utf8'),
    dockerfile: readFileSync('docker/Dockerfile', 'utf8'),
    entrypoint: readFileSync('docker/docker-entrypoint-prod.sh', 'utf8'),
  });
  if (failures.length) {
    console.error(failures.map((failure) => `- ${failure}`).join('\n'));
    process.exit(1);
  }
  console.log('Supply-chain workflow and image privilege invariants passed.');
}
