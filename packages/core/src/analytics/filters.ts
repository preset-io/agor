function escapeRegex(input: string): string {
  return input.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

export function eventNameMatchesPattern(eventName: string, pattern: string): boolean {
  if (!pattern) return false;
  if (!pattern.includes('*')) return eventName === pattern;
  const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`);
  return regex.test(eventName);
}

export function isAnalyticsEventExcluded(
  eventName: string,
  patterns: readonly string[] = []
): boolean {
  return patterns.some((pattern) => eventNameMatchesPattern(eventName, pattern));
}
