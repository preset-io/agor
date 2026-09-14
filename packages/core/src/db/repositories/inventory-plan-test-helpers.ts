import { type SQL, sql } from 'drizzle-orm';

export function bindQuery(query: string, params: unknown[]): SQL {
  return sql.join(
    query
      .split(/(\$\d+)/)
      .map((part) =>
        /^\$\d+$/.test(part) ? sql`${params[Number(part.slice(1)) - 1]}` : sql.raw(part)
      ),
    sql``
  );
}

export function policyLoops(value: unknown): number[] {
  if (!value || typeof value !== 'object') return [];
  const node = value as Record<string, unknown>;
  return [
    ...(node['Parent Relationship'] === 'SubPlan' ? [Number(node['Actual Loops'])] : []),
    ...Object.values(node).flatMap(policyLoops),
  ];
}
