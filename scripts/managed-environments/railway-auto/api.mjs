export class PreviewError extends Error {}
export const requireValue = (condition, message) => {
  if (!condition) throw new PreviewError(message);
};
export const uuid = value =>
  typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
export function nodes(connection) {
  requireValue(
    Array.isArray(connection?.edges) &&
      connection.edges.length <= 100 &&
      connection.pageInfo?.hasNextPage === false,
    'Railway inventory is incomplete or exceeds 100 resources; refusing changes.'
  );
  const result = connection.edges.map(edge => edge.node);
  requireValue(
    result.every(node => node && uuid(node.id)),
    'Invalid Railway resource inventory.'
  );
  return result;
}

export class RailwayAPI {
  constructor(token, request = fetch) {
    requireValue(
      !!token,
      'Save RAILWAY_API_TOKEN as a secure Global workspace/account token. An environment-scoped project token is not sufficient.'
    );
    this.token = token;
    this.request = request;
    this.deadline = AbortSignal.timeout(240_000);
  }
  async query(query, variables = {}) {
    try {
      const response = await this.request('https://backboard.railway.com/graphql/v2', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.any([this.deadline, AbortSignal.timeout(30_000)]),
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      const body = response.ok ? await response.json() : null;
      if (!body?.data || body.errors?.length) throw new Error();
      return body.data;
    } catch {
      throw new PreviewError(
        'Railway did not confirm the request. No mutation was retried. If this followed a mutation, inspect Railway and let it settle before another action; resources may already exist or be running.'
      );
    }
  }
}
