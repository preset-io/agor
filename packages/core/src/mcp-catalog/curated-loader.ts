/**
 * Loader for the MCP catalog file.
 *
 * `curated.yaml` is checked into the repository rather than edited through an
 * admin UI so the catalog is reviewed, versioned, and rolled back like any
 * other change. The loader is strict: a malformed entry fails the whole file
 * rather than silently putting a half-populated card into the marketplace.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MCPCatalogEntry, MCPCatalogTransport } from '@agor/core/types';
import {
  MCP_CATALOG_AUTHORED_AUTH_TYPES,
  MCP_CATALOG_CAPABILITIES,
  MCP_CATALOG_CATEGORIES,
} from '@agor/core/types';
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
 * URLs from this file end up in `<img src>` and in the connect flow's fetch
 * target, so the scheme is constrained here rather than relying on `z.url()`,
 * which accepts any scheme including `javascript:`.
 */
const httpUrl = z.url().refine((value) => /^https?:\/\//i.test(value), {
  message: 'must be an http(s) URL',
});

const catalogEntrySchema = z
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
    /**
     * What the endpoint requires from a client. Omitted where nobody has
     * established it: absence is read as "not stated", never as "open".
     */
    auth_type: z.enum(MCP_CATALOG_AUTHORED_AUTH_TYPES).optional(),
  })
  .strict();

const catalogFileSchema = z
  .object({
    /** Servers published to the MCP registry under exactly the given `name`. */
    entries: z.array(catalogEntrySchema).min(1),
    /**
     * Servers whose vendor runs a public endpoint but has not published to the
     * registry, so `name` is Agor's reverse-DNS guess at the identity.
     */
    unpublished: z.array(catalogEntrySchema).default([]),
  })
  .strict();

/** Absolute path of the checked-in catalog file, alongside its loader. */
export function curatedCatalogPath(): string {
  return path.join(__dirname, 'curated.yaml');
}

/**
 * Parse the catalog file.
 *
 * Both top-level lists are one catalog: every entry in either is offered, and
 * the split exists for a single invariant. `verified` is a user-facing trust
 * badge, so it has to mean that Agor vouches this name identifies the vendor's
 * own server — and under `unpublished:` nothing has confirmed that mapping,
 * because the name is Agor's inference from a domain. Enforcing it here rather
 * than relying on the file staying honest is the point: the data fix alone
 * decays as entries are added.
 *
 * Rejects duplicate `name`s and duplicate `popularity_rank`s across both lists:
 * either would make the marketplace's ordering depend on file order, which is
 * not something a reviewer can see in a diff.
 */
export function parseCuratedCatalog(source: string): MCPCatalogEntry[] {
  let document: unknown;
  try {
    document = loadYaml(source);
  } catch (error) {
    throw new CuratedCatalogError(
      `curated.yaml is not valid YAML: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const parsed = catalogFileSchema.safeParse(document);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new CuratedCatalogError(`curated.yaml failed validation: ${issues}`);
  }

  for (const entry of parsed.data.unpublished) {
    if (entry.verified) {
      throw new CuratedCatalogError(
        `curated.yaml marks ${entry.name} as verified, but it is listed under ` +
          '`unpublished:` — nothing has confirmed that name identifies the ' +
          "vendor's own server. Set `verified: false`, or move the entry to " +
          '`entries:` once the registry publishes it under exactly this name.'
      );
    }
  }

  const parsedEntries = [...parsed.data.entries, ...parsed.data.unpublished];

  const seenNames = new Set<string>();
  const seenRanks = new Map<number, string>();
  for (const entry of parsedEntries) {
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

  return parsedEntries.map((entry) => ({
    ...entry,
    // Derived rather than stated: an entry is dialable exactly when it names an
    // endpoint, and a file that could disagree with itself about that would
    // offer a Connect button with nothing to connect to.
    has_remote: Boolean(entry.remote_url),
    auth_type: entry.auth_type ?? 'unknown',
  }));
}

/** Read and parse the checked-in catalog file. */
export async function loadCuratedCatalog(
  filePath: string = curatedCatalogPath()
): Promise<MCPCatalogEntry[]> {
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
