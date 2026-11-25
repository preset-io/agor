export function invoiceTotalCents(lines: { qty: number; unitCents: number }[]): number {
  return lines.reduce((sum, l) => sum + l.qty * l.unitCents, 0);
}
