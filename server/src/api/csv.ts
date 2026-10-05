// server/src/api/csv.ts — milestone 24. The one place a CSV cell is written.
//
// A value that begins with = + - @ (or a tab or carriage return) is a FORMULA to a spreadsheet: a customer who named
// themselves `=HYPERLINK("http://…")` would have it run on the merchant's machine when they open the export. Those
// cells are prefixed with an apostrophe, the standard defence. Quotes are doubled and every cell is quoted.

export function csvCell(value: string | number | null): string {
  let text = value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function csvTable(header: readonly string[], rows: readonly (readonly (string | number | null)[])[]): string {
  const lines = [header.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  return `${lines.join('\r\n')}\r\n`;
}
