# MCP catalog expansion audit — 2026-09-01

This is the review record for the hosted endpoints added in this change. The
catalog remains a global, checked-in allowlist. Probes are read-only and use the
same outbound-address filtering as Connect; no tenant data, user credential, or
OAuth client is created by the scheduled audit.

## Added

Live checks used a Streamable HTTP `initialize`, `tools/list`, and one benign
read-only call where the server was open. OAuth review additionally followed
the challenge's RFC 9728 protected-resource metadata and RFC 8414/OIDC issuer
metadata, checked resource/issuer binding, PKCE S256, and the advertised DCR
endpoint. The date of every result below is 2026-09-01.

| Server                           | Verified result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Vendor evidence                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub                           | `https://api.githubcopilot.com/mcp/` challenges for OAuth and accepts GitHub's documented PAT bearer route. OAuth metadata has no DCR, so the card intentionally requests a fine-grained PAT and Connect verifies it with a pinned second `initialize`.                                                                                                                                                                                                                                          | [GitHub remote MCP setup](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/set-up-the-github-mcp-server) |
| Microsoft Learn                  | Open `initialize`; listed the three Learn search/fetch tools; documentation search returned Microsoft Learn sources. Public, free, no authentication.                                                                                                                                                                                                                                                                                                                                            | [Microsoft Learn MCP](https://learn.microsoft.com/en-us/training/support/mcp)                                                          |
| Microsoft Release Communications | Open `initialize` and listed Microsoft 365 roadmap and Azure update lookup tools. Public, free, no authentication.                                                                                                                                                                                                                                                                                                                                                                               | [Microsoft Release Communications MCP](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/mrc-mcp)                           |
| AWS Knowledge                    | Open `initialize`; documentation search returned AWS Lambda guidance and sources. No AWS credentials.                                                                                                                                                                                                                                                                                                                                                                                            | [AWS public Knowledge MCP example](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry-sync-records.html)           |
| Twilio Docs                      | Open `initialize`; documentation search returned Twilio SMS sources. The endpoint exposes public docs, not a Twilio project. Twilio labels the service Public Beta, subject to change, and outside its Support Terms and SLA.                                                                                                                                                                                                                                                                    | [Twilio MCP server](https://www.twilio.com/docs/ai/mcp)                                                                                |
| Docker Hardened Images           | Open `initialize` and public catalog/SBOM/CVE tools. Docker documents that only three private-mirror tools require Basic auth; the disclosure explicitly excludes those tools from this open catalog connection.                                                                                                                                                                                                                                                                                 | [Docker DHI MCP](https://docs.docker.com/dhi/tools/mcp/)                                                                               |
| Attio                            | OAuth challenge, exact protected resource, `https://app.attio.com` issuer, DCR, and PKCE S256. Available to members on all plans and acts with the user's permissions.                                                                                                                                                                                                                                                                                                                           | [Attio MCP](https://attio.com/help/reference/how-to-guides/attio-mcp-prompts-and-best-practices)                                       |
| Expo                             | OAuth challenge, same-origin exact resource and issuer, DCR, and PKCE S256. The disclosure separates hosted EAS/project access from local simulator/dev-tools setup.                                                                                                                                                                                                                                                                                                                             | [Expo MCP](https://docs.expo.dev/mcp/)                                                                                                 |
| LaunchDarkly                     | OAuth challenge, path-bound resource/issuer metadata, DCR, and PKCE S256. Vendor documentation says Federal and EU environments are unsupported.                                                                                                                                                                                                                                                                                                                                                 | [LaunchDarkly MCP](https://launchdarkly.com/docs/home/getting-started/mcp)                                                             |
| WorkOS                           | OAuth challenge, exact resource, `https://signin.workos.com` issuer, DCR, and PKCE S256. Vendor controls default new connections to sandbox and gates production/write access.                                                                                                                                                                                                                                                                                                                   | [WorkOS MCP announcement and controls](https://workos.com/blog/install-workos-plugin-claude-chatgpt-codex)                             |
| Datadog                          | The exact US1 resource returns a bare `401`, then path-aware RFC 9728 metadata binds that resource to issuer `https://mcp.datadoghq.com/v1/mcp`. Its RFC 8414 metadata advertises authorization and token endpoints, S256 PKCE, scope `mcp_all`, and unauthenticated public-client DCR at `https://app.datadoghq.com/api/v2/oauth2/register`. The production Marketplace discovery and exact metadata validator accepted the chain. No registration request or client was created during review. | [Datadog MCP setup and authentication](https://docs.datadoghq.com/mcp_server/setup/)                                                   |

Datadog documents OAuth as the recommended authentication method for most
users. Two deployment constraints remain outside the metadata audit: the
checked-in URL is Datadog's US1 endpoint (other sites use regional MCP domains,
and GovCloud is unsupported), and Datadog tells OAuth-client operators to
allow-list redirect URLs under **MCP OAuth Redirect URLs**. It separately asks
partners or vendors adding Datadog to an MCP directory to register interest.
The audit deliberately did not POST to DCR to test either policy, because that
would create an uncontrolled client. An organisation whose callback policy
rejects an Agor deployment must allow-list that deployment's callback before
sign-in can complete.

The `.github/workflows/mcp-catalog-health.yml` audit repeats reachability,
claimed auth, the side-effect-free production protected-resource/issuer and
endpoint validation, PKCE, and client-registration readiness. It runs daily and
on curation/audit pull requests. Transient reachability and indeterminate
metadata results remain annotated advisories; authentication contradictions,
invalid OAuth contracts, and a newly usable OAuth path for a reviewed bearer
exception fail with an actionable annotation. Unit tests replace both probe and
OAuth discovery seams and never use the public internet.

## Explicit exclusions

These were live-probed and reviewed but are not cards:

- **Google Workspace (Gmail, Drive, Calendar, Chat, Docs, Sheets, Slides, and
  Tasks):** Google's hosted servers are Developer Preview. Google requires each
  customer to enable APIs/MCP services in its own Cloud project and provide an
  OAuth client ID and client secret. A globally curated endpoint cannot truthfully
  supply those tenant-owned credentials. [Google configuration guide](https://developers.google.com/workspace/guides/configure-mcp-servers)
- **Slack:** the official endpoint explicitly does not support DCR. Slack
  requires a registered Slack app/client secret and limits production clients
  to directory-listed or internal apps. [Slack MCP authentication](https://docs.slack.dev/ai/slack-mcp-server)
- **Box:** an administrator must enable the integration and create a client ID,
  client secret, and exact redirect URI; live metadata advertises no DCR.
  [Box MCP](https://developer.box.com/guides/box-mcp/)
- **HubSpot:** customers must create an MCP auth app and configure its exact
  callback and client credentials; live metadata advertises no DCR.
  [HubSpot MCP auth](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/mcp)
- **MongoDB Atlas:** the managed endpoint uses an Atlas-created service account
  with client credentials, while user-delegated access requires an Atlas App
  Connection enabled by an organisation owner. Neither is Agor's safe,
  self-registering per-user authorization-code flow. [MongoDB managed MCP overview](https://www.mongodb.com/docs/mcp-server/overview/)
- **Power BI:** the remote endpoint is public preview, tenant-admin enabled,
  permission/licence gated, and uses Microsoft Entra without DCR. Its live
  protected-resource metadata binds the wider Fabric API rather than the exact
  MCP resource. [Power BI remote MCP](https://learn.microsoft.com/en-us/power-bi/developer/mcp/remote-mcp-server-get-started)
- **Typeform:** metadata advertises DCR, but Typeform requires production MCP
  clients' callback domains to be reviewed/allowlisted; an arbitrary Agor
  deployment is not a truthful one-click client. [Typeform connector guide](https://www.typeform.com/developers/mcp/build-connector/)
- **Contentful:** the hosted service requires its MCP Config App per
  space/environment, and the live endpoint did not provide a usable OAuth
  challenge/metadata chain to Agor's probe. [Contentful MCP GA](https://www.contentful.com/help/mcp/)
- **GitBook workspace, Perplexity remote, and other guessed URLs:** no matching
  authoritative hosted-product documentation was established, so a successful
  handshake or a historical URL alone was not enough to ship a card.

No managed-client secret schema was added. Doing so solely for these providers
would turn a reviewed global card into a misleading per-customer integration
wizard, introduce encrypted client-secret lifecycle and HA coordination, and
still not remove the vendors' administrator, preview, publication, or tenant
requirements. Existing per-user installed-server configuration remains the
truthful route for administrators who have such vendor credentials.
