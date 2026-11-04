/** `pluralize(1, 'artifact')` → "1 artifact"; `pluralize(2, 'artifact')` → "2 artifacts". */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
