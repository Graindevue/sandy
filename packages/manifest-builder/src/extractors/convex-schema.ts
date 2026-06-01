import type { ApiSurfaceExtractor, JsonValue } from '@sandy/shared-types';
import { code, oneLine, renderBulletList } from '../markdown.js';

interface ConvexSchemaTable {
  name: string;
  fields: { name: string; validator: string }[];
  indexes: { name: string; fields: string[] }[];
}

const extractor: ApiSurfaceExtractor = {
  key: 'convex-schema',
  title: 'Convex Schema',
  async extract(context) {
    const text = await context.readFile('convex/schema.ts');
    const tables = text === null ? [] : extractTables(text);
    const bullets = tables.flatMap((table) => [
      `${code(table.name)} fields: ${
        table.fields.length === 0
          ? 'none'
          : table.fields.map((field) => `${code(field.name)} ${code(field.validator)}`).join(', ')
      }`,
      ...table.indexes.map(
        (index) => `  - index ${code(index.name)} on ${index.fields.map(code).join(', ')}`,
      ),
    ]);
    return { data: tables as unknown as JsonValue, markdown: renderBulletList(bullets) };
  },
};

export default extractor;

function extractTables(source: string): ConvexSchemaTable[] {
  const tables: ConvexSchemaTable[] = [];
  const patterns = [
    /([A-Za-z_$][\w$]*)\s*:\s*defineTable\s*\(\s*\{/g,
    /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*defineTable\s*\(\s*\{/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      if (name === undefined || tables.some((table) => table.name === name)) {
        continue;
      }
      const objectStart = source.indexOf('{', match.index ?? 0);
      const objectEnd = findMatching(source, objectStart, '{', '}');
      if (objectStart === -1 || objectEnd === -1) {
        continue;
      }
      const fieldsBlock = source.slice(objectStart + 1, objectEnd);
      const chain = source.slice(objectEnd, Math.min(source.length, objectEnd + 1000));
      tables.push({
        name,
        fields: extractFields(fieldsBlock),
        indexes: extractIndexes(chain),
      });
    }
  }

  tables.sort((a, b) => a.name.localeCompare(b.name));
  return tables;
}

function extractFields(block: string): { name: string; validator: string }[] {
  return [...block.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:\s*([^,\n]+)/gm)]
    .map((match) => ({
      name: match[1] ?? '',
      validator: oneLine(match[2] ?? ''),
    }))
    .filter((field) => field.name.length > 0);
}

function extractIndexes(block: string): { name: string; fields: string[] }[] {
  return [...block.matchAll(/\.index\s*\(\s*["']([^"']+)["']\s*,\s*\[([^\]]*)\]/g)].map(
    (match) => ({
      name: match[1] ?? '',
      fields: (match[2] ?? '')
        .split(',')
        .map((field) => field.trim().replaceAll(/["']/g, ''))
        .filter(Boolean),
    }),
  );
}

function findMatching(source: string, start: number, open: string, close: string): number {
  if (start < 0 || source[start] !== open) {
    return -1;
  }
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}
