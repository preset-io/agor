import { loadConfig, saveConfig } from '@agor/core/config';

const rawEnabled = process.argv[2];

if (rawEnabled !== 'true' && rawEnabled !== 'false') {
  throw new Error('Expected "true" or "false" as the tenant CORS development setting');
}

async function main(): Promise<void> {
  const enabled = rawEnabled === 'true';
  const config = await loadConfig();

  config.security = {
    ...config.security,
    cors: {
      ...config.security?.cors,
      tenant_origins: {
        ...config.security?.cors?.tenant_origins,
        enabled,
      },
    },
  };

  await saveConfig(config);

  console.log(
    `${enabled ? '✅' : '⏭️ '} Tenant-managed CORS origins ${enabled ? 'enabled' : 'disabled'} for development`
  );
}

void main();
