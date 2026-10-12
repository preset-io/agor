/** Only protocol field names and fixed reasons may cross the diagnostic boundary.
 * Zod messages can contain input values or unknown (potentially private) keys.
 * Accept legacy {path,message} issues too, without printing their raw text.
 */
const fields = new Set([
  'namespace',
  'cursor',
  'bundle',
  'version',
  'action',
  'slug',
  'display_name',
  'description',
  'resume',
  'entry',
  'key',
  'path',
  'title',
  'icon_emoji',
  'kind',
  'status',
  'sha256',
  'bytes',
  'frontmatter',
  'provenance',
  'content',
  '$limit',
  '$skip',
  '$sort',
  '$select',
  'tenant_id',
]);
const reasons: Record<string, string> = {
  invalid_type: 'Missing field or wrong type',
  too_big: 'Value exceeds the allowed maximum',
  too_small: 'Value is below the allowed minimum',
  unrecognized_keys: 'Unexpected field; not supported by this transfer schema',
  invalid_format: 'Invalid format',
  invalid_string: 'Invalid format',
  invalid_value: 'Unsupported value',
  invalid_enum_value: 'Unsupported value',
  invalid_union: 'Invalid action or request shape',
  custom: 'Invalid value',
};

function safePath(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const result: string[] = [];
  for (const field of input.slice(0, 6)) {
    if (typeof field !== 'string' || !fields.has(field)) {
      result.push('<field>');
      break;
    }
    result.push(field);
    if (field === 'frontmatter' || field === 'provenance') break;
  }
  return result;
}

export function knowledgeTransferValidationIssues(input: unknown) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 8).map((raw: unknown) => {
    const issue = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    let code =
      typeof issue.code === 'string' && Object.hasOwn(reasons, issue.code) ? issue.code : 'custom';
    if (issue.code === undefined && typeof issue.message === 'string') {
      // Old daemons did not send a code. Classify, never echo their message.
      if (/^(Invalid input: expected|Expected|Required)/.test(issue.message)) code = 'invalid_type';
      else if (/^(Too big|String must contain at most)/.test(issue.message)) code = 'too_big';
      else if (/^(Too small|String must contain at least)/.test(issue.message)) code = 'too_small';
      else if (/^Unrecognized key/.test(issue.message)) code = 'unrecognized_keys';
      else if (/^Invalid/.test(issue.message)) code = 'invalid_value';
    }
    const path = safePath(issue.path);
    // Unknown field names may themselves contain secrets. Show known protocol
    // extras only; do not include arbitrary keys from a strict-schema failure.
    if (code === 'unrecognized_keys' && Array.isArray(issue.keys)) {
      const known = issue.keys.find((key) => typeof key === 'string' && fields.has(key));
      if (known) path.push(known);
    }
    return { path, code, message: reasons[code] };
  });
}

export function knowledgeTransferValidationSummary(input: unknown): string {
  return knowledgeTransferValidationIssues(input)
    .map(({ path, message }) => `${path.join('.') || 'request'}: ${message}`)
    .join('; ');
}
