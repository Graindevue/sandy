export function renderBulletList(items: readonly string[]): string {
  if (items.length === 0) {
    return 'None detected.';
  }
  return items.map((item) => (item.startsWith('  ') ? item : `- ${item}`)).join('\n');
}

export function renderMarkdownTable(headers: readonly string[], rows: readonly string[][]): string {
  if (rows.length === 0) {
    return 'None detected.';
  }
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escapeTableCell).join(' | ')} |`),
  ].join('\n');
}

export function code(value: string): string {
  return `\`${value.replaceAll('`', '\\`')}\``;
}

export function oneLine(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim();
}

function escapeTableCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', '<br>');
}
