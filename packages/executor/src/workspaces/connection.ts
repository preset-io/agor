import { readFile } from 'node:fs/promises';
import { Signer } from '@aws-sdk/rds-signer';
import postgres from 'postgres';

/** The trusted controller obtains a new IAM token on each database connection. */
export async function connectWorkspaceAuthority(config: {
  databaseUrl: string;
  sslCaPath: string;
  databaseIamAuth?: boolean;
  region?: string;
}) {
  const address = new URL(config.databaseUrl);
  const signer = config.databaseIamAuth
    ? new Signer({
        hostname: address.hostname,
        port: Number(address.port || 5432),
        username: decodeURIComponent(address.username),
        region: config.region ?? 'ap-southeast-2',
      })
    : undefined;
  return postgres(config.databaseUrl, {
    max: 10,
    ssl: { ca: await readFile(config.sslCaPath, 'utf8'), rejectUnauthorized: true },
    ...(signer ? { password: () => signer.getAuthToken() } : {}),
  });
}
