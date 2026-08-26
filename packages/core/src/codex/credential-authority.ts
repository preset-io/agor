/**
 * Files that carry credential-file mutation authority beside the credential.
 *
 * These names are part of the shared on-disk protocol used by daemon writers,
 * executor helpers, and the bubblewrap containment policy. Keep the runtime
 * values here so a new authority sidecar cannot silently escape the sandbox
 * mask while still participating in credential mutation.
 */
export const CREDENTIAL_AUTHORITY_GENERATION_FILENAME = '.agor-auth-generation' as const;
export const CREDENTIAL_AUTHORITY_LOCK_FILENAME = '.agor-auth-mutation.lock' as const;

export const CREDENTIAL_AUTHORITY_SIDECAR_FILENAMES = [
  CREDENTIAL_AUTHORITY_GENERATION_FILENAME,
  CREDENTIAL_AUTHORITY_LOCK_FILENAME,
] as const;
