/**
 * Is this URL somewhere someone ELSE'S browser can open?
 *
 * One predicate, three callers, because the three were three different
 * answers to the same question and only one of them was right. The gateway's
 * session link refused `0.0.0.0` and nothing else; `gatewaySessionConnectUrl`
 * copied that check; the Slack connect card checked nothing at all. So a
 * static deployment that never set a public base URL fell back to
 * `http://localhost:3030`, which passes both existing checks, and posted a
 * Block Kit card whose button works for exactly one person on earth — whoever
 * is sitting at the daemon.
 *
 * A link nobody can open is worse than no link, because both of this lane's
 * surfaces hand it to somebody: the card puts it under a button in a Slack
 * thread, and the agent is instructed to paste `relay_to_user` into the
 * conversation. Refusing makes it a reversible refusal an administrator can
 * fix — set the deployment's public base URL and the next backoff posts the
 * card — rather than a card that looks delivered and is not.
 *
 * Deliberately NOT a reachability probe: no DNS, no request, no allowlist.
 * It answers the one question that can be decided from the string, which is
 * whether the host names this machine.
 */

/** `127.0.0.0/8` — the whole loopback block, not just `127.0.0.1`. */
const LOOPBACK_IPV4 = /^127(?:\.\d{1,3}){3}$/;

/**
 * Hostnames that can only ever mean "the machine that generated this link".
 *
 * `0.0.0.0` and `::` are bind addresses rather than destinations; `localhost`,
 * its RFC 6761 subdomains, and the IPv4/IPv6 loopback literals resolve back to
 * whoever opened them. `URL.hostname` keeps IPv6 literals bracketed, which is
 * why those are matched bracketed.
 */
function hostnameIsLocalOnly(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!host) return true;
  if (host === '0.0.0.0' || host === '[::]' || host === '[::0]') return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '[::1]') return true;
  return LOOPBACK_IPV4.test(host);
}

/**
 * True when `url` is a non-empty absolute URL on a host other than this one.
 *
 * Accepts a base URL or a full deep link — both are parsed the same way, and
 * the only thing read is the host.
 */
export function isBrowserReachableUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return !hostnameIsLocalOnly(new URL(url).hostname);
  } catch {
    return false;
  }
}
