export interface ExternalAppLink {
  href: string;
  label: string;
}

/** Deployment-configured external app link (e.g. a hosting console); only absolute http(s) URLs are honored. */
export function resolveExternalAppLink(
  link: string | undefined,
  label: string | undefined
): ExternalAppLink | undefined {
  if (!link) return undefined;
  try {
    const { protocol } = new URL(link);
    if (protocol !== 'http:' && protocol !== 'https:') return undefined;
  } catch {
    return undefined;
  }
  return { href: link, label: label || link };
}
