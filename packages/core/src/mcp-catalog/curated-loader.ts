/**
 * Loader for the curated MCP catalog overlay.
 *
 * `curated.yaml` is checked into the repository rather than edited through an
 * admin UI so curation is reviewed, versioned, and rolled back like any other
 * change. The loader is strict: a malformed entry fails the whole file rather
 * than silently seeding a half-populated card into the marketplace.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  MCPCatalogCategory,
  MCPCatalogCurationUpsert,
  MCPCatalogTransport,
} from '@agor/core/types';
import { MCP_CATALOG_CAPABILITIES, MCP_CATALOG_CATEGORIES } from '@agor/core/types';
import { z } from 'zod';
import { load as loadYaml } from '../yaml';

/** Thrown when `curated.yaml` cannot be parsed or fails validation. */
export class CuratedCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CuratedCatalogError';
  }
}

const TRANSPORTS = ['streamable-http', 'sse', 'stdio'] as const satisfies readonly [
  MCPCatalogTransport,
  ...MCPCatalogTransport[],
];

const nonEmpty = z.string().trim().min(1);

/**
 * Curated URLs end up in `<img src>` and in the connect flow's fetch target, so
 * the scheme is constrained here rather than relying on `z.url()`, which accepts
 * any scheme including `javascript:`.
 */
const httpUrl = z.url().refine((value) => /^https?:\/\//i.test(value), {
  message: 'must be an http(s) URL',
});

const curatedEntrySchema = z
  .object({
    name: nonEmpty,
    category: z.enum(MCP_CATALOG_CATEGORIES),
    capabilities: z.array(z.enum(MCP_CATALOG_CAPABILITIES)).min(1).max(6),
    benefit: nonEmpty,
    starter_prompt: nonEmpty,
    permission_disclosure: nonEmpty,
    title: nonEmpty.optional(),
    description: nonEmpty.optional(),
    icon_url: httpUrl.optional(),
    website_url: httpUrl.optional(),
    verified: z.boolean().default(false),
    popularity_rank: z.int().positive().optional(),
    remote_url: httpUrl.optional(),
    transport: z.enum(TRANSPORTS).optional(),
  })
  .strict();

const curatedFileSchema = z
  .object({
    entries: z.array(curatedEntrySchema).min(1),
  })
  .strict();

export type CuratedCatalogEntry = MCPCatalogCurationUpsert & {
  category: MCPCatalogCategory;
};

/** Absolute path of the checked-in curation file, alongside its loader. */
export function curatedCatalogPath(): string {
  return path.join(__dirname, 'curated.yaml');
}

/**
 * Parse curation YAML.
 *
 * Rejects duplicate `name`s and duplicate `popularity_rank`s: both would make
 * the marketplace's ordering depend on file order, which is not something a
 * reviewer can see in a diff.
 */
export function parseCuratedCatalog(source: string): CuratedCatalogEntry[] {
  let document: unknown;
  try {
    document = loadYaml(source);
  } catch (error) {
    throw new CuratedCatalogError(
      `curated.yaml is not valid YAML: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const parsed = curatedFileSchema.safeParse(document);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new CuratedCatalogError(`curated.yaml failed validation: ${issues}`);
  }

  const entries = parsed.data.entries;

  const seenNames = new Set<string>();
  const seenRanks = new Map<number, string>();
  for (const entry of entries) {
    if (seenNames.has(entry.name)) {
      throw new CuratedCatalogError(`curated.yaml has duplicate entry name: ${entry.name}`);
    }
    seenNames.add(entry.name);

    if (entry.popularity_rank !== undefined) {
      const owner = seenRanks.get(entry.popularity_rank);
      if (owner) {
        throw new CuratedCatalogError(
          `curated.yaml has duplicate popularity_rank ${entry.popularity_rank} on ${owner} and ${entry.name}`
        );
      }
      seenRanks.set(entry.popularity_rank, entry.name);
    }
  }

  return entries;
}

/** Read and parse the checked-in curation file. */
export async function loadCuratedCatalog(
  filePath: string = curatedCatalogPath()
): Promise<CuratedCatalogEntry[]> {
  let source: string;
  try {
    source = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    throw new CuratedCatalogError(
      `Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return parseCuratedCatalog(source);
}
