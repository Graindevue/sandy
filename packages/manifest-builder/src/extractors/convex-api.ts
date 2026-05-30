import type { ApiSurfaceExtractor, JsonValue } from '@sandy/shared-types';
import { code, oneLine, renderMarkdownTable } from '../markdown.js';

interface ConvexApiEntry {
  name: string;
  kind: 'query' | 'mutation' | 'action';
  path: string;
  line: number;
  args: string | null;
}

const API_RE = /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(query|mutation|action)\s*\(\s*\{/g;

const extractor: ApiSurfaceExtractor = {
  key: 'convex-api',
  title: 'Convex API',
  async extract(context) {
    const files = (await context.listFiles()).filter(
      (file) =>
        file.startsWith('convex/') &&
        /\.[cm]?tsx?$/.test(file) &&
        !file.includes('/_generated/') &&
        !file.endsWith('/schema.ts'),
    );
    const entries: ConvexApiEntry[] = [];
    for (const file of files) {
      const text = await context.readFile(file);
      if (text === null) {
        continue;
      }
      for (const match of text.matchAll(API_RE)) {
        const name = match[1];
        const kind = match[2];
        if (name === undefined || !isKind(kind)) {
          continue;
        }
        const declaration = text.slice(
          match.index ?? 0,
          Math.min(text.length, (match.index ?? 0) + 1500),
        );
        entries.push({
          name,
          kind,
          path: file,
          line: lineNumberAt(text, match.index ?? 0),
          args: extractArgs(declaration),
        });
      }
    }
    entries.sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
    return {
      data: entries as unknown as JsonValue,
      markdown: renderMarkdownTable(
        ['Kind', 'Name', 'Path', 'Args'],
        entries.map((entry) => [
          code(entry.kind),
          code(entry.name),
          `${code(entry.path)}:${entry.line}`,
          entry.args === null ? '' : code(entry.args),
        ]),
      ),
    };
  },
};

export default extractor;

function isKind(value: string | undefined): value is ConvexApiEntry['kind'] {
  return value === 'query' || value === 'mutation' || value === 'action';
}

function extractArgs(declaration: string): string | null {
  const argsIndex = declaration.search(/\bargs\s*:/);
  if (argsIndex === -1) {
    return null;
  }
  const afterArgs = declaration.slice(argsIndex).replace(/^args\s*:\s*/, '');
  const end = afterArgs.search(/,\s*(handler|returns)\s*:/);
  const raw = end === -1 ? afterArgs.slice(0, 160) : afterArgs.slice(0, end);
  return oneLine(raw).replace(/,$/, '');
}

function lineNumberAt(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}
