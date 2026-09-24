import { defineRailway, github, project, service, volume } from 'railway/iac';

// SQLite-only, single-replica bootstrap for the first Railway deployment.
// Before using this as a PR-environment template, replace the bootstrap branch
// with the intended baseline. Generated domains are managed in Railway.
export default defineRailway(() => {
  const data = volume('agor-data', { region: 'sfo', sizeMB: 500 });
  const agor = service('agor', {
    source: github('preset-io/agor', { branch: 'investigate-railway-environment-variants' }),
    build: { builder: 'DOCKERFILE', dockerfilePath: 'docker/Dockerfile' },
    replicas: { sfo: 1 },
    healthcheck: '/health',
    healthcheckTimeout: 120,
    deploy: {
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 3,
      overlapSeconds: 0,
    },
    env: {
      AGOR_RUNTIME_TARGET: 'production-source',
      RAILWAY_DOCKERFILE_PATH: 'docker/Dockerfile',
      NODE_ENV: 'production',
      HOME: '/home/agor',
      PORT: '3030',
      DAEMON_PORT: '3030',
      DAEMON_HOST: '0.0.0.0',
      AGOR_AGENTIC_TOOLS: 'none',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Railway resolves this reference, not JavaScript.
      AGOR_BASE_URL: 'https://${{RAILWAY_PUBLIC_DOMAIN}}',
    },
    volumeMounts: { '/home/agor/.agor': data },
  });
  return project('Agor', { resources: [agor, data] });
});
