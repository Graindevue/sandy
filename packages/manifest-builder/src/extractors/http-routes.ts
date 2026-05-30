import type { ApiSurfaceExtractor, JsonValue } from '@sandy/shared-types';
import { code, renderMarkdownTable } from '../markdown.js';

interface HttpRouteEntry {
  method: string;
  route: string;
  path: string;
  source: 'nextjs' | 'convex';
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

const extractor: ApiSurfaceExtractor = {
  key: 'http-routes',
  title: 'HTTP Routes',
  async extract(context) {
    const files = await context.listFiles();
    const entries: HttpRouteEntry[] = [];
    for (const file of files) {
      if (file.endsWith('/route.ts') || file.endsWith('/route.tsx')) {
        const text = await context.readFile(file);
        if (text === null) {
          continue;
        }
        for (const method of extractNextMethods(text)) {
          entries.push({ method, route: routeFromNextFile(file), path: file, source: 'nextjs' });
        }
      }
    }

    const convexHttp = await context.readFile('convex/http.ts');
    if (convexHttp !== null) {
      entries.push(...extractConvexRoutes(convexHttp));
    }

    entries.sort(
      (a, b) =>
        a.route.localeCompare(b.route) ||
        a.method.localeCompare(b.method) ||
        a.path.localeCompare(b.path),
    );
    return {
      data: entries as unknown as JsonValue,
      markdown: renderMarkdownTable(
        ['Route', 'Source', 'Path'],
        entries.map((entry) => [
          code(`${entry.method} ${entry.route}`),
          code(entry.source),
          code(entry.path),
        ]),
      ),
    };
  },
};

export default extractor;

function extractNextMethods(source: string): string[] {
  const found = new Set<string>();
  for (const method of HTTP_METHODS) {
    const re = new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${method}\\b`);
    if (re.test(source)) {
      found.add(method);
    }
  }
  return [...found].sort();
}

function routeFromNextFile(file: string): string {
  const parts = file.split('/');
  const appIndex = parts.lastIndexOf('app');
  const segments = parts.slice(appIndex + 1, -1).filter((part) => {
    return part.length > 0 && !part.startsWith('(') && !part.startsWith('@');
  });
  const route = segments.map(nextSegmentToRouteSegment).join('/');
  return `/${route}`.replaceAll(/\/+/g, '/') || '/';
}

function nextSegmentToRouteSegment(segment: string): string {
  const optionalCatchAll = segment.match(/^\[\[\.\.\.([A-Za-z0-9_$-]+)\]\]$/);
  if (optionalCatchAll?.[1] !== undefined) {
    return `:${optionalCatchAll[1]}*`;
  }
  const catchAll = segment.match(/^\[\.\.\.([A-Za-z0-9_$-]+)\]$/);
  if (catchAll?.[1] !== undefined) {
    return `:${catchAll[1]}*`;
  }
  const dynamic = segment.match(/^\[([A-Za-z0-9_$-]+)\]$/);
  if (dynamic?.[1] !== undefined) {
    return `:${dynamic[1]}`;
  }
  return segment;
}

function extractConvexRoutes(source: string): HttpRouteEntry[] {
  const entries: HttpRouteEntry[] = [];
  for (const match of source.matchAll(/http\.route\s*\(\s*\{([\s\S]*?)\}\s*\)/g)) {
    const body = match[1] ?? '';
    const path = body.match(/\bpath\s*:\s*["']([^"']+)["']/)?.[1];
    const method = body.match(/\bmethod\s*:\s*["']([^"']+)["']/)?.[1]?.toUpperCase();
    if (path === undefined || method === undefined) {
      continue;
    }
    entries.push({ method, route: path, path: 'convex/http.ts', source: 'convex' });
  }
  return entries;
}
