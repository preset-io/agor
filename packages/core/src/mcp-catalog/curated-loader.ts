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
  MCP_OAUTH_COMPATIBILITY_MODES,
  MCP_OAUTH_DCR_MODES,
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

/**
 * The per-server OAuth settings an entry may state.
 *
 * `.strict()` is what keeps a secret out. The obvious mistake this file invites
 * is pasting a whole OAuth client configuration into an entry, and the
 * dangerous halves of one — `client_secret`, `token_url`, `authorization_url` —
 * are exactly the keys someone would reach for. Under `.strict()` any of them
 * fails the load loudly at review time and on the first catalog read, rather
 * than being dropped in silence: a published client secret that nobody was
 * told about is strictly worse than a catalog that will not parse. See
 * {@link MCPCatalogEntryOAuth} for why each accepted key is accepted.
 */
const catalogEntryOAuthSchema = z
  .object({
    scope: nonEmpty.optional(),
    client_id: nonEmpty.optional(),
    dcr_mode: z.enum(MCP_OAUTH_DCR_MODES).optional(),
    compatibility_mode: z.enum(MCP_OAUTH_COMPATIBILITY_MODES).optional(),
  })
  .strict()
  // An `oauth: {}` that states nothing is a reviewer's leftover, and it reads
  // as though something was configured. Absence is how an entry says "discover
  // it all", and there should be exactly one way to say that.
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'must state at least one setting, or be omitted entirely',
  })
  // `disabled` is the one mode that has to bring its own client. The other two
  // allow registration to supply one, so an absent `client_id` there is the
  // ordinary case; with registration off, nothing else can supply it and
  // `startOAuthFlow` refuses the pair. That refusal lands per-user at sign-in,
  // long after the entry was reviewed, which is the wrong place to learn that a
  // combination could never have worked.
  .refine((value) => value.dcr_mode !== 'disabled' || value.client_id !== undefined, {
    message: 'must state a client_id when dcr_mode is disabled, since nothing else can supply one',
  });

const catalogEntryCredentialsSchema = z
  .object({
    scheme: z.literal('bearer'),
    acquisition_url: httpUrl,
    label: nonEmpty.optional(),
    oauth_challenge_compatible: z.literal(true).optional(),
  })
  .strict();

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
    popularity_rank: z.int().positive().optional(),
    remote_url: httpUrl.optional(),
    transport: z.enum(TRANSPORTS).optional(),
    /**
     * What the endpoint requires from a client. Omitted where nobody has
     * established it: absence is read as "not stated", never as "open".
     */
    auth_type: z.enum(MCP_CATALOG_AUTHORED_AUTH_TYPES).optional(),
    /**
     * Settings for the OAuth flow, used when connecting finds the endpoint
     * wants one. Not gated on `auth_type`: the probe decides what an endpoint
     * requires, so an entry stating `none` that has since been put behind an
     * account still gets these, and an entry stating `oauth` that has been
     * opened up simply never uses them.
     */
    oauth: catalogEntryOAuthSchema.optional(),
    credentials: catalogEntryCredentialsSchema.optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.auth_type === 'credentials' && !entry.credentials) {
      context.addIssue({
        code: 'custom',
        path: ['credentials'],
        message: 'is required when auth_type is credentials',
      });
    }
    if (entry.credentials && entry.auth_type !== 'credentials') {
      context.addIssue({
        code: 'custom',
        path: ['credentials'],
        message: 'is only valid when auth_type is credentials',
      });
    }
  });

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
 * Refuse an entry the marketplace could offer but never install.
 *
 * The condition is connect's own: `assertConnectableEntry` refuses anything
 * without a `remote_url`, and anything declaring `stdio`. An entry failing that
 * is not a lesser entry, it is an unusable one — it renders a card, a category,
 * a disclosure and a Connect affordance, and every route out of that card is a
 * refusal. Two such entries shipped, and nothing in the file, the loader, or
 * the tests objected; the marketplace simply had two shelves nobody could take
 * anything off. That silence is the defect this closes. The rule is stated here
 * so a file that cannot work fails where a curator is looking, rather than
 * per-user at the point of pressing Connect.
 *
 * This does not replace connect's check, which stays. The loader constrains the
 * checked-in file; connect authorizes a request, and the remote-only rule it
 * enforces is a security boundary — `stdio` names a command the executor runs on
 * its host, next to every session. A boundary that held only because an input
 * file had been validated somewhere else would be one bad catalog source away
 * from not holding at all.
 *
 * Local servers are not deferred by this, they are declined. Installing a
 * package-based entry means executing third-party code on the executor host,
 * which is a supply-chain decision rather than a credential one, and it is the
 * risk the members-remote-only rule exists to contain. Whatever eventually
 * offers local servers has to answer that question first, and will need its own
 * fields to describe how the thing is run — the two removed entries carried
 * none, because the package data that would have described them lived in the
 * registry mirror. So this is not a rule to relax when local support lands; it
 * is a rule that will be replaced by one that knows what it is admitting.
 */
function assertEntryIsServable(entry: {
  name: string;
  remote_url?: string;
  transport?: MCPCatalogTransport;
}): void {
  if (entry.transport === 'stdio') {
    throw new CuratedCatalogError(
      `curated.yaml entry ${entry.name} declares transport: stdio, which the marketplace cannot install. ` +
        'Give it the vendor\'s remote endpoint and a remote transport ("streamable-http" or "sse"), or remove the entry.'
    );
  }
  if (!entry.remote_url) {
    throw new CuratedCatalogError(
      `curated.yaml entry ${entry.name} names no remote_url, so nothing could ever install it. ` +
        'Add the vendor\'s remote MCP endpoint (and transport: "streamable-http" or "sse" if it is not the default), or remove the entry.'
    );
  }
}

/**
 * Parse the catalog file.
 *
 * Both top-level lists are one catalog: every entry in either is offered. The
 * split records how the entry's `name` was arrived at — the registry publishes
 * a server under exactly that name, or Agor inferred it from the vendor's
 * domain. That is a curation fact, checked by a reviewer against a diff, and it
 * survives here because nothing in the running system could recover it later:
 * once parsed, an inferred name is indistinguishable from a confirmed one.
 *
 * Rejects duplicate `name`s and duplicate `popularity_rank`s across both lists:
 * either would make the marketplace's ordering depend on file order, which is
 * not something a reviewer can see in a diff.
 *
 * Rejects entries the catalog could never serve: see
 * {@link assertEntryIsServable}.
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

  const parsedEntries = [...parsed.data.entries, ...parsed.data.unpublished];

  const seenNames = new Set<string>();
  const seenRanks = new Map<number, string>();
  for (const entry of parsedEntries) {
    assertEntryIsServable(entry);

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
    //
    // Now always true, because {@link assertEntryIsServable} has already
    // refused the file otherwise. Kept as a derivation rather than hardcoded:
    // it states the reason a served entry is dialable, and it is what the
    // consumers of `MCPCatalogEntry` — which still types `remote_url` as
    // optional — read instead of re-deriving it.
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
