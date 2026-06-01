import type { ApiSurfaceExtractor, JsonValue } from '@sandy/shared-types';
import { code, renderBulletList } from '../markdown.js';

interface I18nFile {
  path: string;
  keys: string[];
}

const I18N_ROOTS = ['messages/', 'locales/', 'i18n/'];

const extractor: ApiSurfaceExtractor = {
  key: 'i18n-keys',
  title: 'i18n Keys',
  async extract(context) {
    const files = (await context.listFiles()).filter(
      (file) => I18N_ROOTS.some((root) => file.startsWith(root)) && /\.json$/.test(file),
    );
    const entries: I18nFile[] = [];
    for (const file of files) {
      const text = await context.readFile(file);
      if (text === null) {
        continue;
      }
      entries.push({ path: file, keys: flattenJsonKeys(JSON.parse(text)) });
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    const bullets = entries.flatMap((entry) => [
      code(entry.path),
      ...entry.keys.map((key) => `  - ${code(key)}`),
    ]);
    return { data: entries as unknown as JsonValue, markdown: renderBulletList(bullets) };
  },
};

export default extractor;

function flattenJsonKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return prefix.length === 0 ? [] : [prefix];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
    flattenJsonKeys(nested, prefix.length === 0 ? key : `${prefix}.${key}`),
  );
}
