import { pathToFileURL } from 'node:url';

// Deliberately limited to the existing single-operator bootstrap deployment.
// Per-branch provisioning must supply an authorized resource binding instead.
const target = Object.freeze({
  projectId: 'aa86ab4f-8ccd-466f-b29c-27a818594081',
  environmentId: 'c5cfea2f-c938-4ad4-a285-73b2c77469fc',
  serviceId: '28acddc0-1370-4b2e-89d0-37230b205380',
});

export async function setBootstrapPassword(env = process.env, request = fetch) {
  const password = env.RAILWAY_AGOR_ADMIN_PASSWORD;
  const token = env.RAILWAY_API_KEY || env.RAILWAY_TOKEN;
  if (!token) throw new Error('Missing Railway project token (RAILWAY_TOKEN).');
  if (!password) throw new Error('Missing RAILWAY_AGOR_ADMIN_PASSWORD.');
  if ([...password].length < 15 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('Admin password must be at least 15 characters and at most 72 UTF-8 bytes.');
  }
  // The secret goes only in the HTTPS request body to Railway, never in shell
  // arguments, rendered branch snapshots, an IaC graph, or a build argument.
  // Do not follow redirects with the project credential or expose API bodies.
  try {
    const response = await request('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/json', 'Project-Access-Token': token },
      body: JSON.stringify({
        query:
          'mutation SetBootstrapPassword($input: VariableUpsertInput!) { variableUpsert(input: $input) }',
        variables: {
          input: {
            ...target,
            name: 'AGOR_ADMIN_PASSWORD',
            value: password,
            skipDeploys: true,
          },
        },
      }),
    });
    if (!response.ok) throw new Error('Request failed');
    const result = await response.json();
    if (result.errors?.length || result.data?.variableUpsert !== true) {
      throw new Error('Mutation failed');
    }
  } catch {
    // Provider and transport diagnostics can contain request data. Never echo.
    throw new Error(
      'Could not set Railway bootstrap password; credentials and provider response withheld.'
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await setBootstrapPassword();
    console.log(
      'Railway bootstrap password configured. Existing accounts were not changed; no deployment started.'
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
