export function csvCell(v: unknown): string {
  let s = String(v ?? '');
  // spreadsheet formula-injection guard: text only. Real numbers (e.g. a negative balance) must stay numbers.
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function buildCsv(rows: any[][]): string {
  return '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
